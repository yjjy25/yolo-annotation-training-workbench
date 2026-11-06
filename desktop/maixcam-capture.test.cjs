/* Mock-camera regression for the WiFi capture engine: no MaixCAM required. */
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createMaixcamCapture,cameraUrl,parseInterval,isJpeg,FILE_PREFIX}=require('./maixcam-capture.cjs');

const jpeg=Buffer.from([255,216,255,192,0,11,8,5,0,2,208,1,1,17,0,255,217]);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function settings(){
 assert.equal(cameraUrl('192.168.1.2').url,'http://192.168.1.2:8080/snapshot.jpg');
 assert.equal(cameraUrl('192.168.1.2:9000').url,'http://192.168.1.2:9000/snapshot.jpg');
 assert.equal(cameraUrl('http://192.168.1.2:9000').url,'http://192.168.1.2:9000/snapshot.jpg');
 assert.equal(cameraUrl('192.168.1.2:9000/other').port,9000);
 for(const address of ['','https://192.168.1.2','http://user:pass@camera','192.168.1.2:xyz','ftp://192.168.1.2','192.168.1.2:0'])
  assert.throws(()=>cameraUrl(address),undefined,`地址应被拒绝: ${address}`);
 assert.equal(parseInterval('0.5'),0.5);
 for(const value of [0,0.01,-1,'abc',NaN,Infinity,61])assert.throws(()=>parseInterval(value));
 assert.ok(isJpeg(jpeg));assert.ok(!isJpeg(Buffer.from('nope')));assert.ok(!isJpeg(Buffer.from([255,216])));
}

function mockCamera(){
 const state={sequence:1,ready:true,requests:0};
 const server=http.createServer((request,response)=>{
  if(request.url.startsWith('/snapshot.jpg')){
   state.requests++;
   if(!state.ready){response.writeHead(503);response.end('stale');return;}
   response.writeHead(200,{'Content-Type':'image/jpeg','X-Frame-Sequence':String(state.sequence),'Cache-Control':'no-store'});
   response.end(jpeg);
  }else if(request.url.startsWith('/status.json')){
   response.writeHead(200,{'Content-Type':'application/json'});
   response.end(JSON.stringify({ready:state.ready,sequence:state.sequence,width:1280,height:720,fps:10,quality:85}));
  }else{response.writeHead(404);response.end('no');}
 });
 return {state,server,listen:()=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),
  close:()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);})};
}

(async()=>{
 settings();
 const staging=fs.mkdtempSync(path.join(os.tmpdir(),'maixcam-capture-test-'));
 const camera=mockCamera();
 await camera.listen();
 const port=camera.server.address().port;
 const events=[],imports=[],prefs={};
 let failImport=false;
 const capture=createMaixcamCapture({
  staging,prefs,writePrefs:()=>{},
  getProject:()=>({name:'测试项目',root:'/virtual/project'}),
  isReady:()=>true,
  importImages:async paths=>{
   assert.ok(paths.length&&paths.every(file=>fs.existsSync(file)),'入库前暂存图片必须存在');
   if(failImport)throw new Error('模拟入库失败');
   imports.push(paths);return {count:paths.length,skipped:0};
  },
  emit:(type,payload)=>events.push({type,payload}),
  pollMs:20,previewMs:40,staleMs:250,batchSize:2,batchMs:100000,timeoutMs:500
 });
 const staged=()=>fs.readdirSync(staging).filter(name=>name.startsWith(FILE_PREFIX)&&name.endsWith('.jpg'));
 try{
  await assert.rejects(()=>capture.connect({address:'http://127.0.0.1:1'}),/./,'不可达设备应连接失败');
  assert.equal(capture.status().connected,false,'失败后不应留下半连接');

  const connected=await capture.connect({address:`127.0.0.1:${port}`});
  assert.equal(connected.connected,true);
  assert.equal(prefs.maixcam.address,`127.0.0.1:${port}`,'设备地址应被记住');
  assert.ok(events.some(item=>item.type==='frame'&&item.payload?.url?.startsWith('data:image/jpeg;base64,')));
  assert.ok(events.some(item=>item.type==='status'));
  await wait(80);
  assert.ok(capture.status().device?.width===1280,'应读到板端 status.json');

  // A frozen camera must not fill the dataset with copies of the same frame.
  assert.equal(capture.start({interval:0.1}).saving,true);
  assert.equal(prefs.maixcam.interval,0.1);
  await wait(320);
  assert.equal(staged().length,1,'同一帧号在一次采集中只保存一次');

  const advance=setInterval(()=>{camera.state.sequence++;},55);
  await wait(360);
  clearInterval(advance);
  await wait(30);
  const stopped=await capture.stop();
  assert.equal(stopped.saving,false);
  assert.ok(imports.length>=1,'采集的照片应分批交给 import_images');
  assert.ok(stopped.imported>=2,'新帧应按间隔入库');
  assert.equal(stopped.staged,0,'入库成功后暂存文件应被清理');

  const before=capture.status().totalCaptured;
  await capture.single();
  assert.equal(capture.status().totalCaptured,before+1,'单张拍照也应计入');
  assert.equal(capture.status().staged,0,'单张拍照后立即入库');

  // An import failure keeps every photo on disk and offers a retry.
  failImport=true;
  capture.start({interval:0.1});
  await wait(180);
  const failed=await capture.stop();
  assert.ok(failed.staged>=1,'入库失败时照片必须保留');
  assert.match(failed.message,/入库失败/);
  failImport=false;
  await capture.flush();
  assert.equal(capture.status().staged,0,'重试入库应清空暂存');

  // A stale / disconnected camera stops capture but keeps the connection alive
  // for a later manual restart.
  camera.state.ready=false;
  capture.start({interval:0.1});
  await wait(420);
  assert.equal(capture.status().saving,false,'画面中断后应停止连续采集');
  const offline=await capture.disconnect();
  assert.equal(offline.connected,false);
  assert.ok(events.some(item=>item.type==='error'));
  capture.shutdown();
  console.log('MaixCAM capture: address validation, intervals, JPEG check, preview, frame de-duplication, batch import, single shot, import retry and stale-frame stop passed.');
 }finally{
  capture.shutdown();
  await camera.close();
  fs.rmSync(staging,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
