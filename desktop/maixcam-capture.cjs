/* WiFi capture from a MaixCAM HTTP camera, imported straight into the open
 * project's dataset. The renderer CSP forbids network access, so every request
 * lives here in the main process; frames reach the page as data URLs over IPC.
 *
 * Flow: poll /snapshot.jpg -> drop repeated frames -> write original JPEGs to a
 * staging folder OUTSIDE the project -> hand batches to the existing
 * import_images RPC, which copies them into <project>/images with its own
 * decode check, digest de-duplication and safe renaming. Nothing here writes
 * into the project directly, so the dataset rules stay in one place.
 *
 * No Electron imports: all dependencies are injected so the whole flow can be
 * exercised against a local mock camera (see maixcam-capture.test.cjs).
 */
const nodeHttp=require('node:http');
const nodeFs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const MAX_JPEG=20*1024*1024;
const DEFAULT_PORT=8080;
const FILE_PREFIX='maixcam_';

function cameraUrl(address){
 let text=String(address??'').trim();
 if(!text)throw new Error('请输入 MaixCAM 的 IP 地址。');
 if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(text))text='http://'+text;
 let parsed;
 try{parsed=new URL(text);}catch{throw new Error('设备地址格式不正确，请输入 IP、IP:端口或 http://IP:端口。');}
 if(parsed.protocol!=='http:')throw new Error('只支持局域网 http 地址，不要使用 https。');
 if(parsed.username||parsed.password)throw new Error('设备地址不能包含账号和密码。');
 if(!parsed.hostname)throw new Error('设备地址缺少主机名。');
 const port=parsed.port?Number(parsed.port):DEFAULT_PORT;
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('端口需在 1～65535 之间。');
 const host=parsed.hostname; // URL keeps IPv6 brackets
 const base=`http://${host}:${port}`;
 return {host,port,address:text,base,url:`${base}/snapshot.jpg`,statusUrl:`${base}/status.json`};
}

function parseInterval(value){
 const number=Number(value);
 if(!Number.isFinite(number)||number<0.1||number>60)throw new Error('拍照间隔需为 0.1～60 秒之间的数字。');
 return number;
}

function isJpeg(data){
 return Buffer.isBuffer(data)&&data.length>=3&&data[0]===0xff&&data[1]===0xd8&&data[2]===0xff;
}

function fetchFrame(httpClient,url,timeout=3000){
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;error?reject(error):resolve(value);};
  const request=httpClient.get(url,{headers:{'Cache-Control':'no-cache'},agent:false},response=>{
   if(response.statusCode!==200){
    response.resume();
    finish(new Error(response.statusCode===503?'摄像头尚未就绪或画面已停止更新，请检查板端程序。':`设备返回 HTTP ${response.statusCode}，请确认运行的是配套采集程序。`));
    return;
   }
   const type=String(response.headers['content-type']||'').split(';')[0].trim().toLowerCase();
   if(type!=='image/jpeg'){response.resume();finish(new Error('设备返回的不是 JPG，请确认已运行配套板端程序。'));return;}
   const chunks=[];let size=0;
   response.on('data',chunk=>{
    size+=chunk.length;
    if(size>MAX_JPEG){chunks.length=0;finish(new Error('图像超过 20 MB 限制。'));request.destroy();return;}
    chunks.push(chunk);
   });
   response.on('end',()=>{
    const data=Buffer.concat(chunks);
    if(!isJpeg(data)){finish(new Error('设备返回的 JPG 数据不完整。'));return;}
    finish(null,{data,sequence:response.headers['x-frame-sequence']??null,at:Date.now()});
   });
   response.on('error',error=>finish(error));
  });
  // Settle before destroying: destroy() can emit a socket error and otherwise
  // replaces the useful timeout message with "socket hang up".
  request.setTimeout(timeout,()=>{finish(new Error('连接设备超时，请检查 IP 和局域网。'));request.destroy();});
  request.on('error',error=>finish(error));
 });
}

function fetchStatus(httpClient,url,timeout=1500){
 // Optional device metadata; a missing /status.json (older board script) is fine.
 return new Promise(resolve=>{
  let settled=false,size=0;const chunks=[];
  const done=value=>{if(settled)return;settled=true;resolve(value);};
  const request=httpClient.get(url,{agent:false},response=>{
   if(response.statusCode!==200){response.resume();done(null);return;}
   response.on('data',chunk=>{size+=chunk.length;if(size<=65536)chunks.push(chunk);else done(null);});
   response.on('end',()=>{try{done(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{done(null);}});
   response.on('error',()=>done(null));
  });
  request.setTimeout(timeout,()=>{done(null);request.destroy();});
  request.on('error',()=>done(null));
 });
}

function createMaixcamCapture(options={}){
 const fileSystem=options.fs||nodeFs;
 const httpClient=options.httpClient||nodeHttp;
 const staging=options.staging;
 if(!staging)throw new Error('缺少采集暂存目录。');
 const emit=options.emit||(()=>{});
 const log=options.log||(()=>{});
 const prefs=options.prefs||{};
 const writePrefs=options.writePrefs||(()=>{});
 const getProject=options.getProject||(()=>null);
 const isReady=options.isReady||(()=>true);
 const importImages=options.importImages||(async()=>({count:0}));
 const now=options.now||(()=>Date.now());
 const pollMs=options.pollMs??100;
 const previewMs=options.previewMs??200;
 const staleMs=options.staleMs??3000;
 const batchSize=options.batchSize??20;
 const batchMs=options.batchMs??3000;
 const timeoutMs=options.timeoutMs??3000;
 fileSystem.mkdirSync(staging,{recursive:true});

 let connection=null,session=null,flushing=null;
 let lastError='',previewAt=0,totalCaptured=0,totalImported=0,generation=0;
 const saved=()=>(prefs.maixcam&&typeof prefs.maixcam==='object')?prefs.maixcam:(prefs.maixcam={});
 const remember=(patch)=>{Object.assign(saved(),patch);writePrefs();};

 function stagedFiles(){
  try{
   return fileSystem.readdirSync(staging)
    .filter(name=>name.startsWith(FILE_PREFIX)&&name.toLowerCase().endsWith('.jpg'))
    .map(name=>path.join(staging,name))
    .filter(file=>{try{return fileSystem.statSync(file).isFile();}catch{return false;}})
    .sort();
  }catch{return [];}
 }

 function status(){
  const project=getProject();
  return {
   connected:!!connection,
   address:connection?connection.address:(saved().address||''),
   url:connection?connection.url:'',
   device:connection?.device||null,
   saving:!!session,
   interval:session?session.interval:(Number(saved().interval)||0.5),
   captured:session?.captured||0,
   totalCaptured,imported:totalImported,staged:stagedFiles().length,
   lastFrameAt:connection?.lastFrame?.at||0,
   ready:isReady(),project:project?.name||null,projectRoot:project?.root||null,
   message:lastError,scriptPath:options.scriptPath||''
  };
 }
 function emitStatus(){emit('status',status());}
 function noteError(message){lastError=message;emit('error',{message});log('MaixCAM: '+message);}
 function stopPolling(){if(connection?.timer)clearTimeout(connection.timer);if(connection)connection.timer=null;}
 function schedule(delay){
  if(!connection)return;
  const token=generation;
  connection.timer=setTimeout(()=>{if(connection&&generation===token)tick(token);},Math.max(0,delay));
 }

 function writeFrame(data,tag){
  const name=`${FILE_PREFIX}${tag}_${now()}_${crypto.randomUUID().slice(0,8)}.jpg`;
  const target=path.join(staging,name);
  try{
   const fd=fileSystem.openSync(target,'wx'); // exclusive: never overwrite a photo
   try{fileSystem.writeFileSync(fd,data);}catch(error){fileSystem.closeSync(fd);fileSystem.unlinkSync(target);throw error;}
   fileSystem.closeSync(fd);
   return target;
  }catch(error){
   noteError(`照片写入失败：${error.message}。请检查磁盘空间与目录权限。`);
   return null;
  }
 }

 function acceptFrame(frame){
  const at=now();
  const sequence=frame.sequence===null||frame.sequence===undefined?'':String(frame.sequence);
  const key=sequence||crypto.createHash('sha1').update(frame.data).digest('hex');
  connection.lastFrame={data:frame.data,key,at};
  if(at-previewAt>=previewMs){
   previewAt=at;
   emit('frame',{url:'data:image/jpeg;base64,'+frame.data.toString('base64'),sequence:frame.sequence,at});
  }
  if(!session)return;
  // Switching projects mid-capture must never silently file photos into the
  // wrong dataset. Keep them staged and let the user choose where to retry.
  if(getProject()?.root!==session.projectRoot){
   session=null;
   noteError('项目已切换，采集已停止。已拍照片保留在暂存目录，点“重试入库”可加入当前项目。');
   emitStatus();
   return;
  }
  if(key===session.lastKey||at<session.nextDue)return;
  if(!writeFrame(frame.data,'capture')){session=null;emitStatus();return;}
  session.captured+=1;totalCaptured+=1;
  session.nextDue=at+session.interval*1000;
  session.lastKey=key;
  emitStatus();
  if(stagedFiles().length>=batchSize||at-session.lastFlush>=batchMs)void flush().catch(()=>{});
 }

 async function tick(token){
  if(!connection||generation!==token)return;
  const conn=connection;
  try{
   const frame=await fetchFrame(httpClient,conn.url,timeoutMs);
   if(!connection||generation!==token||connection!==conn)return;
   conn.failures=0;conn.lastSuccess=now();lastError='';
   acceptFrame(frame);
  }catch(error){
   if(!connection||generation!==token||connection!==conn)return;
   conn.failures+=1;lastError=error.message;
   if(session&&now()-conn.lastSuccess>=staleMs){
    session=null;
    noteError(`画面中断，已停止采集：${error.message}。已拍照片会保留并入库。`);
    void flush().catch(()=>{});
   }else if(conn.failures===1){
    emit('error',{message:error.message});
   }
   emitStatus();
  }
  if(connection===conn&&generation===token)schedule(pollMs);
 }

 function flush(){
  if(flushing)return flushing;
  const files=stagedFiles();
  if(!files.length){if(session)session.lastFlush=now();return Promise.resolve({count:0});}
  if(!getProject()?.root){
   const error=new Error('请先新建或打开项目，采集的照片才能加入数据集。');
   noteError(error.message);return Promise.reject(error);
  }
  if(!isReady()){
   const error=new Error('本地引擎尚未就绪，照片已暂存，可稍后点“重试入库”。');
   noteError(error.message);return Promise.reject(error);
  }
  flushing=(async()=>{
   try{
    const result=await importImages(files);
    for(const file of files){try{fileSystem.unlinkSync(file);}catch{}}
    const count=Number(result?.count)||files.length;
    totalImported+=count;
    if(session)session.lastFlush=now();
    lastError='';
    emit('imported',{count,skipped:Number(result?.skipped)||0,total:totalImported});
    emitStatus();
    return result;
   }catch(error){
    noteError(`入库失败：${error.message}。照片已保留，可点“重试入库”。`);
    if(session){session=null;emitStatus();}
    throw error;
   }finally{flushing=null;}
  })();
  return flushing;
 }

 async function drain(){
  // A batch can finish while new photos were being written; pick those up too.
  for(let attempt=0;attempt<3&&stagedFiles().length;attempt++){
   try{await flush();}catch(error){log('MaixCAM drain: '+error.message);break;}
  }
 }

 async function connect(options={}){
  const parsed=cameraUrl(options.address);
  await disconnect();
  const first=await fetchFrame(httpClient,parsed.url,timeoutMs); // fail before claiming a connection
  generation+=1;
  const token=generation;
  connection={...parsed,timer:null,failures:0,lastSuccess:now(),lastFrame:null,device:null};
  lastError='';
  acceptFrame(first);
  remember({address:String(options.address??parsed.address).trim()});
  emitStatus();
  schedule(0);
  void fetchStatus(httpClient,parsed.statusUrl,Math.min(timeoutMs,1500)).then(info=>{
   if(connection&&generation===token&&info){connection.device=info;emitStatus();}
  });
  return status();
 }

 async function disconnect(){
  generation+=1;stopPolling();connection=null;session=null;
  try{await drain();}catch{}
  emit('frame',{url:null});
  emitStatus();
  return status();
 }

 function start(options={}){
  if(!connection)throw new Error('请先连接 MaixCAM。');
  if(session)throw new Error('正在采集中，请先停止。');
  if(!getProject()?.root)throw new Error('请先新建或打开项目，采集的照片会直接进入该项目的数据集。');
  if(!isReady())throw new Error('本地引擎正在启动，请稍候再开始采集。');
  if(!connection.lastFrame||now()-connection.lastFrame.at>staleMs)throw new Error('画面已过期，请重新连接后再采集。');
  const interval=parseInterval(options.interval??saved().interval??0.5);
  session={interval,nextDue:0,lastKey:null,lastFlush:now(),captured:0,projectRoot:getProject().root};
  remember({interval});
  lastError='';emitStatus();
  return status();
 }

 async function stop(){
  session=null;emitStatus();
  await drain();
  return status();
 }

 async function single(){
  if(!connection?.lastFrame||now()-connection.lastFrame.at>staleMs)throw new Error('画面已过期，请等待新画面或重新连接。');
  if(!getProject()?.root)throw new Error('请先新建或打开项目。');
  if(!isReady())throw new Error('本地引擎正在启动，请稍候。');
  if(!writeFrame(connection.lastFrame.data,'single'))throw new Error(lastError||'照片写入失败。');
  totalCaptured+=1;
  emitStatus();
  await drain();
  return status();
 }

 function shutdown(){
  // On quit there is no time for another RPC; staged photos survive for the
  // next launch and the page offers "重试入库" to import them.
  generation+=1;stopPolling();session=null;connection=null;emitStatus();
 }

 return {connect,disconnect,start,stop,single,flush,drain,status,shutdown};
}

module.exports={createMaixcamCapture,cameraUrl,parseInterval,isJpeg,fetchFrame,FILE_PREFIX};
