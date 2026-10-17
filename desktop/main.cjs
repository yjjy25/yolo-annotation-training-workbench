const {app, BrowserWindow, ipcMain, nativeTheme, screen, shell, nativeImage, dialog} = require('electron');
const {spawn,execFile} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const packaged=fs.existsSync(path.join(process.resourcesPath,'workbench'));
const ROOT=packaged?path.join(process.resourcesPath,'workbench'):path.resolve(__dirname,'..');
const portable=packaged&&fs.existsSync(path.join(path.dirname(process.execPath),'portable.flag'));
const RUNTIME=packaged?(portable?path.join(path.dirname(process.execPath),'工作台数据'):path.join(app.getPath('appData'),'AnnotationTrainingWorkbench')):path.join(ROOT,'.runtime');
fs.mkdirSync(RUNTIME,{recursive:true});
app.setPath('userData',path.join(RUNTIME,process.env.XAL_ELECTRON_QA?'electron-qa-user':'electron-user'));
const PREFS=path.join(RUNTIME,process.env.XAL_ELECTRON_QA?'qa-desktop-preferences.json':'desktop-preferences.json');
let prefs={theme:'dark'};
try { prefs={...prefs,...JSON.parse(fs.readFileSync(PREFS,'utf8'))}; } catch {}
if(!['light','dark','system'].includes(prefs.theme)) prefs.theme='dark';
nativeTheme.themeSource=prefs.theme;
let win, backend=null, ready=false, workspace=false, closing=false,quitPending=false,quitTimer=null;
let current={event:'state',project:null,training:'idle',predicting:false,embedded:false};
let nativeDiagnostics=null;
const diagnosticWaiters=new Map();
const requests=new Map();
const rpcMethods=new Set(['create_project','open_project','load_annotation','save_annotation','add_class','mode','start_training','stop_training','predict','stop_predict','accept','start_validation','stop_validation','model_classes','split_preview','remove_image']);
function request(method,args={}){
  if(!ready)return Promise.reject(new Error(current.error||'本地引擎正在启动，请稍候。'));
  const request_id=require('node:crypto').randomUUID();
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{requests.delete(request_id);reject(new Error('操作用时较长，请查看日志并核对项目状态后再试。'));},120000);
    requests.set(request_id,message=>{clearTimeout(timeout);message.ok?resolve(message.result):reject(new Error(message.error));});
    send({action:'rpc',method,args,request_id});
  });
}
function diagnostics(){
  const id=require('node:crypto').randomUUID();
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{diagnosticWaiters.delete(id);reject(new Error('Native diagnostics timed out'));},10000);
    diagnosticWaiters.set(id,message=>{clearTimeout(timeout);resolve(message);});
    send({action:'diagnostics',request_id:id});
  });
}
const commands=new Set(['new_project','open_project','manual','pretrained','train','pose','review','weights','predict','stop_predict','accept','approve','next','folder','tool','mode','image']);
const log=message=>fs.appendFileSync(path.join(RUNTIME,'electron-main.log'),new Date().toISOString()+' '+message+'\n');
const bounded=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('操作超时')),ms))]);
function recoverDraft(draft){
  if(!draft?.annotation||typeof draft.name!=='string')return null;
  const directory=path.join(RUNTIME,process.env.XAL_ELECTRON_QA?'electron-qa':'','recovery');fs.mkdirSync(directory,{recursive:true});
  const target=path.join(directory,Date.now()+'-'+require('node:crypto').randomUUID()+'.json');
  fs.writeFileSync(target,JSON.stringify({...draft,savedAt:new Date().toISOString()},null,2));return target;
}
async function beginQuit(){
  if(quitPending||closing)return;
  quitPending=true;
  if(['starting','training'].includes(current.training)||current.predicting||current.native_training||current.native_exporting){
    const answer=await dialog.showMessageBox(win,{type:'question',message:'任务仍在运行，停止任务并退出？',detail:'已有标注、训练检查点和结果会保留。',buttons:['继续工作','停止任务并退出'],defaultId:0,cancelId:0});
    if(answer.response!==1){quitPending=false;return;}
  }
  log('Quit requested');
  quitTimer=setTimeout(()=>finishQuit({}),2500);
  win.webContents.send('desktop:before-close');
}
async function finishQuit(payload={}){
  if(closing)return;closing=true;clearTimeout(quitTimer);
  const recovery=recoverDraft(payload.draft);
  if(payload.draft&&ready){try{if(payload.draft.project!==current.project?.root)throw new Error('项目已切换，保留恢复副本。');await bounded(request('save_annotation',{name:payload.draft.name,annotation:payload.draft.annotation,base_hash:payload.draft.base_hash,checked:false}),3000);}catch(error){log('Draft retained at '+recovery+': '+error.message);}}
  try{if(ready)await bounded(request('prepare_exit'),4000);}catch(error){log('Backend shutdown: '+error.message);}
  if(backend?.exitCode===null){
    try{await bounded(new Promise(resolve=>backend.once('exit',resolve)),1000);}catch{}
    if(backend.exitCode===null){
      if(process.platform==='win32')await new Promise(resolve=>execFile('taskkill',['/PID',String(backend.pid),'/T','/F'],{windowsHide:true},()=>resolve()));
      else backend.kill('SIGTERM');
    }
  }
  if(process.env.XAL_QA_EXITCASE){const report=path.join(RUNTIME,'exit-'+process.env.XAL_QA_EXITCASE+'.json');let previous={};try{previous=JSON.parse(fs.readFileSync(report,'utf8'));}catch{}fs.writeFileSync(report,JSON.stringify({...previous,exited:true,recovery,pid:backend?.pid,project:current.project?.root,at:new Date().toISOString()},null,2));}
  log('Quit complete');if(win&&!win.isDestroyed())win.destroy();app.quit();
}

function send(command){
  if(backend && !backend.killed && backend.stdin.writable) backend.stdin.write(JSON.stringify(command)+'\n');
}
function resolvedTheme(){ return nativeTheme.shouldUseDarkColors?'dark':'light'; }
function pushTheme(){
  // The Qt engine also paints the retained advanced tools, so every theme change
  // has to reach it as well, not only the page CSS.
  send({action:'theme',theme:resolvedTheme()});
}
function publish(){
  if(win && !win.isDestroyed()) win.webContents.send('desktop:state',{...current,ready,workspace,theme:prefs.theme,resolvedTheme:nativeTheme.shouldUseDarkColors?'dark':'light',platform:process.platform});
}
function setWorkspace(value){ workspace=!!value; send({action:'workspace',visible:workspace}); layout(); publish(); }
function layout(){
  if(!win || win.isDestroyed()) return;
  // Qt lays the workspace window out in logical pixels, so the geometry the
  // embedded window receives must stay logical too. Multiplying by the display
  // scale factor here made the Qt window twice as large on HiDPI screens: the
  // 1800x1200 clamp kicked in, the captured frame no longer matched the panel,
  // and the canvas visibly jumped between sizes. The scale still travels along,
  // because the offscreen Qt platform always reports a device pixel ratio of 1
  // and would otherwise hand back a soft 1x bitmap on this display.
  const [width,height]=win.getContentSize();
  const scale=screen.getDisplayMatching(win.getBounds()).scaleFactor;
  send({action:'resize',rect:[240,94,Math.max(100,width-240),Math.max(100,height-94)].map(v=>Math.round(v)),scale});
}
function writePrefs(){
  // RUNTIME already exists, but the QA profile folder is created lazily; writing
  // into a missing directory used to throw and silently discard the theme choice.
  try{
    fs.mkdirSync(path.dirname(PREFS),{recursive:true});
    fs.writeFileSync(PREFS+'.tmp',JSON.stringify(prefs));
    fs.renameSync(PREFS+'.tmp',PREFS);
    return true;
  }catch(error){log('Preferences write failed: '+error.message);return false;}
}
function startBackend(){
  if(backend && backend.exitCode===null) return;
  const linuxPortable=path.join(ROOT,'.runtime','linux-python','bin','python3');
  const windowsPortable=path.join(ROOT,'.runtime','python','python.exe');
  const python=process.platform==='win32'?(fs.existsSync(windowsPortable)?windowsPortable:path.join(ROOT,'.venv','Scripts','python.exe')):(fs.existsSync(linuxPortable)?linuxPortable:(fs.existsSync(path.join(ROOT,'.runtime','linux-venv','bin','python'))?path.join(ROOT,'.runtime','linux-venv','bin','python'):path.join(ROOT,'.venv','bin','python')));
  if(!fs.existsSync(python)){ current.error='未找到应用运行环境，请查看本地使用说明。'; publish(); return; }
  ready=false;
  const handle=win.getNativeWindowHandle();
  const parent=process.platform==='win32'?(handle.length>=8?handle.readBigUInt64LE().toString():String(handle.readUInt32LE())):'0';
  const profile=process.env.XAL_ELECTRON_QA?path.join(RUNTIME,'electron-qa'):RUNTIME;
  backend=spawn(python,['-u',path.join(ROOT,'.runtime','launcher.pyw')],{cwd:ROOT,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,XAL_ELECTRON:'1',XAL_INTEGRATED_EDITOR:'1',XAL_OFFSCREEN_TOOLS:'1',QT_QPA_PLATFORM:'offscreen',QT_SCALE_FACTOR:'1',XAL_PROFILE_HOME:profile,YOLO_CONFIG_DIR:path.join(profile,'ultralytics'),XAL_FONT_FILE:path.join(ROOT,'.runtime','fonts','NotoSansSC.ttf'),XAL_PRETRAINED_HOME:path.join(ROOT,'.runtime','pretrained'),XAL_EMBED_PARENT:parent,XAL_THEME:nativeTheme.shouldUseDarkColors?'dark':'light',PYTHONIOENCODING:'utf-8'}});
  const startupTimer=setTimeout(()=>{if(!ready&&backend?.exitCode===null){current.error='本地引擎启动超过 60 秒，请查看启动日志。画布直接集成在工具内，无需连接外部服务。';publish();}},60000);
  readline.createInterface({input:backend.stdout}).on('line',line=>{
    let message; try {message=JSON.parse(line);} catch {log(line);return;}
    if(message.event==='ready'){
      clearTimeout(startupTimer);
      ready=true; current.embedded=message.embedded;
      pushTheme();
      send({action:'workspace',visible:workspace}); layout();
    } else if(message.event==='state') current={...current,...message,error:null};
    else if(message.event==='native_frame'){if(win&&!win.isDestroyed())win.webContents.send('desktop:native-frame',message);return;}
    else if(message.event==='response'){const resolve=requests.get(message.request_id);if(resolve){requests.delete(message.request_id);resolve(message);}}
    else if(message.event==='diagnostics') {nativeDiagnostics=message;const resolve=diagnosticWaiters.get(message.request_id);if(resolve){diagnosticWaiters.delete(message.request_id);resolve(message);}}
    else if(message.event==='error') {current.error=message.message;log(message.message);}
    else if(message.event==='quit-requested') {beginQuit();return;}
    else if(message.event==='closed') {closing=true; if(win&&!win.isDestroyed())win.destroy();app.quit();}
    else if(message.event==='close-cancelled') closing=false;
    publish();
  });
  backend.stderr.on('data',data=>log(data.toString('utf8')));
  backend.on('error',error=>{ready=false;current.error=error.message;publish();});
  backend.on('exit',(code,signal)=>{clearTimeout(startupTimer);log(`Backend exited ${code} ${signal}`); ready=false; for(const resolve of requests.values())resolve({ok:false,error:'本地引擎已退出，请查看日志。'});requests.clear();if(!closing){current.error='本地引擎已退出。可重启引擎，详情见启动日志。';publish();} });
}

ipcMain.handle('desktop:rpc',async(_event,method,args={})=>{
  if(!rpcMethods.has(method))return {ok:false,error:'不支持的操作。'};
  try{return {ok:true,result:await request(method,args)};}catch(error){return {ok:false,error:error.message};}
});
ipcMain.handle('desktop:choose',async(_event,kind)=>{
  if(!['source','root','project','weights','image','video'].includes(kind))return null;
  const options=kind==='source'||kind==='root'?{properties:['openDirectory','createDirectory']}:{properties:['openFile'],filters:kind==='image'?[{name:'图片',extensions:['png','jpg','jpeg','bmp','webp','tif','tiff']}]:kind==='video'?[{name:'视频',extensions:['mp4','avi','mov','mkv','webm','m4v']}]:[{name:kind==='project'?'项目':'模型',extensions:[kind==='project'?'json':'pt']}]};
  const selection=await dialog.showOpenDialog(win,options);
  return selection.canceled?null:selection.filePaths[0];
});
ipcMain.handle('desktop:defaults',()=>({projects:path.join(packaged?RUNTIME:ROOT,'我的项目')}));
ipcMain.on('desktop:native-input',(_event,data)=>{if(data&&typeof data==='object')send({...data,action:'native_input'});});
ipcMain.on('desktop:native-view',(_event,data)=>{if(data&&typeof data==='object')send({...data,action:'native_view'});});
ipcMain.handle('desktop:asset',(_event,name)=>{
  if(typeof name!=='string'||path.basename(name)!==name||!current.project)throw new Error('图片名称无效。');
  const location=path.join(current.project.root,'images',name);
  if(!/\.(png|jpe?g|bmp|webp|tiff?)$/i.test(name))throw new Error('图片格式不支持。');
  const bitmap=nativeImage.createFromPath(location);
  if(bitmap.isEmpty())throw new Error('图片无法解码；可用原版工具打开此图片。');
  return {url:bitmap.toDataURL(),...bitmap.getSize()};
});
ipcMain.handle('desktop:models',()=>{
  if(!current.project)return [];
  const directory=path.join(current.project.root,'runs');
  try{return fs.readdirSync(directory,{withFileTypes:true}).filter(item=>item.isDirectory()).map(item=>({name:item.name,weights:path.join(directory,item.name,'weights','best.pt')})).filter(item=>fs.existsSync(item.weights)).reverse();}catch{return [];}
});
ipcMain.handle('desktop:results',()=>current.project?shell.openPath(path.join(current.project.root,'runs')):null);
ipcMain.handle('desktop:validation-history',()=>{
  if(!current.project)return [];
  const directory=path.join(current.project.root,'validation');
  try{
    return fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>{
      const record=path.join(directory,entry.name,'metrics.json');
      if(!fs.existsSync(record))return null;
      try{return {id:entry.name,...JSON.parse(fs.readFileSync(record,'utf8'))};}catch{return null;}
    }).filter(Boolean).sort((a,b)=>String(b.at||b.id).localeCompare(String(a.at||a.id)));
  }catch{return [];}
});
// Result plots live inside the project, never outside it: the requested path is
// resolved first and then checked to still sit under runs/ or validation/.
ipcMain.handle('desktop:result-image',(_event,relative,maxWidth=1100)=>{
  if(typeof relative!=='string'||!current.project)throw new Error('结果图片路径无效。');
  if(!/\.(png|jpe?g|webp)$/i.test(relative))throw new Error('结果图片格式不支持。');
  const root=fs.realpathSync(current.project.root);
  const allowed=['runs','validation','datasets'].map(name=>path.join(root,name));
  const target=path.resolve(current.project.root,relative);
  const inside=allowed.some(base=>{try{return fs.realpathSync(target).startsWith(fs.realpathSync(base)+path.sep);}catch{return false;}});
  if(!inside)throw new Error('结果图片必须位于项目的训练或验证目录内。');
  const bitmap=nativeImage.createFromPath(target);
  if(bitmap.isEmpty())throw new Error('结果图片无法解码。');
  const size=bitmap.getSize();
  const limit=Math.min(2200,Math.max(240,Number(maxWidth)||1100));
  const image=size.width>limit?bitmap.resize({width:limit,height:Math.round(size.height*limit/size.width),quality:'best'}):bitmap;
  return {url:image.toDataURL(),width:image.getSize().width,height:image.getSize().height};
});
ipcMain.handle('desktop:plot-list',()=>{
  if(!current.project)return {run:null,plots:[],history:[],latest:null};
  const root=current.project.root;
  const wanted=['results.png','confusion_matrix.png','confusion_matrix_normalized.png','PR_curve.png','F1_curve.png','P_curve.png','R_curve.png','val_batch0_pred.jpg','val_batch0_labels.jpg','labels.jpg'];
  const runs=path.join(root,'runs');
  let records=[];
  try{
    records=fs.readdirSync(runs,{withFileTypes:true}).filter(entry=>entry.isDirectory())
      .map(entry=>({name:entry.name,at:fs.statSync(path.join(runs,entry.name)).mtimeMs}))
      .filter(entry=>fs.existsSync(path.join(runs,entry.name,'weights','best.pt')))
      .sort((a,b)=>b.at-a.at);
  }catch{records=[];}
  if(!records.length)return {run:null,plots:[],history:[],latest:null};
  // results.csv is the structured per-epoch record; the text log does not
  // contain epoch rows when verbose is off.
  const history=[];
  for(const record of records.slice(0,6)){
    const csv=path.join(runs,record.name,'results.csv');
    if(!fs.existsSync(csv))continue;
    try{
      const lines=fs.readFileSync(csv,'utf8').trim().split(/\r?\n/);
      const header=lines[0].split(',').map(value=>value.trim());
      const rows=lines.slice(1).map(line=>line.split(',')).filter(cells=>cells.length===header.length);
      history.push({run:record.name,columns:header,rows});
    }catch{}
  }
  const newest=records[0].name,directory=path.join(runs,newest);
  const plots=wanted.filter(name=>fs.existsSync(path.join(directory,name)))
    .map(name=>({name,relative:path.join('runs',newest,name).split(path.sep).join('/'),run:newest}));
  return {run:newest,plots,history,latest:history[0]||null};
});

ipcMain.handle('desktop:state',()=>({...current,ready,workspace,theme:prefs.theme,resolvedTheme:resolvedTheme(),platform:process.platform}));
// Lets the retained-tool panel learn the scale Qt rasterised at.
ipcMain.handle('desktop:diagnostics',async()=>{try{return await diagnostics();}catch(error){return {error:error.message};}});
ipcMain.handle('desktop:command',(_event,action,payload={})=>{
  if(!commands.has(action)) throw new Error('Unsupported action');
  if(!ready) return {ok:false,error:'标注引擎正在启动，请稍候。'};
  setWorkspace(true);
  const safe={action};
  if(action==='mode' && ['manual','pretrained','trained'].includes(payload.mode)) safe.mode=payload.mode;
  if(action==='tool' && ['rectangle','polygon','rotation','point','line','circle'].includes(payload.tool)) safe.tool=payload.tool;
  if(action==='image' && typeof payload.name==='string' && path.basename(payload.name)===payload.name) safe.name=payload.name;
  send(safe);return {ok:true};
});
ipcMain.handle('desktop:workspace',(_event,value)=>{setWorkspace(value);return true;});
ipcMain.handle('desktop:theme',(_event,theme)=>{
  if(!['light','dark','system'].includes(theme))return false;
  prefs.theme=theme; nativeTheme.themeSource=theme;
  writePrefs();
  pushTheme();publish();return true;
});
ipcMain.handle('desktop:window',(_event,action)=>{
  if(action==='minimize')win.minimize();
  if(action==='maximize')win.isMaximized()?win.unmaximize():win.maximize();
  if(action==='close')win.close();
});
ipcMain.handle('desktop:retry',()=>{if(ready){publish();return true;}if(backend&&backend.exitCode===null){current.error='引擎仍在启动，请查看日志定位原因。';publish();}else startBackend();return true;});
ipcMain.handle('desktop:logs',()=>shell.openPath(path.join(RUNTIME,'startup.log')));
// Gallery thumbnails are cached per file+mtime. Every save reloads the list, and
// re-encoding each visible thumbnail on every reload is what made polygon work
// feel like it stalled.
const thumbnailCache=new Map();
const THUMBNAIL_LIMIT=600;
function thumbnailFor(directory,name,tile){
  const location=path.join(directory,name);
  let stamp=0;
  try{stamp=fs.statSync(location).mtimeMs;}catch{return '';}
  const key=location+'|'+stamp+'|'+tile.width+'x'+tile.height;
  const cached=thumbnailCache.get(key);
  if(cached!==undefined)return cached;
  const image=nativeImage.createFromPath(location);
  const url=image.isEmpty()?'':image.resize({...tile,quality:'best'}).toDataURL();
  if(thumbnailCache.size>=THUMBNAIL_LIMIT)thumbnailCache.clear();
  thumbnailCache.set(key,url);
  return url;
}
ipcMain.handle('desktop:images',(_event,options={})=>{
  const root=current.project?.root;
  if(!root || !fs.existsSync(path.join(root,'project.json')))return {items:[],total:0,pages:1,page:0};
  const directory=path.join(root,'images');
  // Thumbnails are decoded at display resolution, not at a fixed 200x150: on a
  // 200% display the old size was stretched to roughly 3x and the gallery looked
  // soft. `dpr` comes from the renderer so 1x screens keep paying the small cost.
  const dpr=Math.min(3,Math.max(1,Number(options.dpr)||1));
  const tile={width:Math.round(300*dpr),height:Math.round(200*dpr)};
  const size=[24,48,96].includes(Number(options.size))?Number(options.size):24;
  try{let entries=fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isFile()&&/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(entry.name)).filter(entry=>!options.search||entry.name.toLowerCase().includes(String(options.search).toLowerCase())).map(entry=>{
    let status='unlabeled';try{const data=JSON.parse(fs.readFileSync(path.join(root,'annotations',path.parse(entry.name).name+'.json'),'utf8'));status=data.checked===true?'checked':'draft';}catch{}
    return {name:entry.name,status};
  }).filter(entry=>!options.filter||options.filter==='all'||options.filter==='pending'&&entry.status!=='checked'||entry.status===options.filter);
  const total=entries.length,pages=Math.max(1,Math.ceil(total/size)),page=Math.min(pages-1,Math.max(0,Number.isInteger(options.page)?options.page:0));
  return {total,pages,page,size,items:entries.slice(page*size,page*size+size).map(entry=>({...entry,thumbnail:thumbnailFor(directory,entry.name,tile)}))};}catch{return {items:[],total:0,pages:1,page:0};}
});
nativeTheme.on('updated',()=>{pushTheme();publish();});

const ownsInstance=process.env.XAL_ELECTRON_QA || app.requestSingleInstanceLock();
if(!ownsInstance)app.quit();
app.on('second-instance',()=>{if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}});
app.whenReady().then(()=>{
  if(!ownsInstance)return;
  const area=screen.getPrimaryDisplay().workAreaSize;
  win=new BrowserWindow({width:Math.min(1500,area.width),height:Math.min(960,area.height),minWidth:1050,minHeight:700,frame:false,show:!process.env.XAL_ELECTRON_QA,backgroundColor:'#0f1116',icon:path.join(__dirname,'icon.png'),title:'标注训练工作台',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  win.on('resize',layout); win.on('move',layout);
  win.on('close',event=>{event.preventDefault();if(!closing)beginQuit();});
  win.loadFile(path.join(__dirname,'studio.html'));
  win.webContents.on('did-finish-load',()=>{publish();startBackend();if(process.env.XAL_ELECTRON_QA)runQA();});
});
app.on('window-all-closed',()=>app.quit());
ipcMain.handle('desktop:close-ready',(_event,payload)=>{
  finishQuit(payload||{});return true;
});

async function runQA(){
  if(process.env.XAL_PACKAGE_TEST)return require('./package-qa.cjs')({win,app,backend:()=>backend,request,diagnostics,ready:()=>ready,testRoot:process.env.XAL_PACKAGE_TEST_ROOT});
  if(process.env.XAL_QA_EXITCASE)return require('./exit-qa.cjs')({win,app,backend:()=>backend,request,ready:()=>ready,root:ROOT});
  if(process.env.XAL_QA_INLINE)return require('./inline-qa.cjs')({win,app,backend:()=>backend,request,diagnostics,ready:()=>ready,root:ROOT});
  if(process.env.XAL_QA_HIRES)return require('./hires-qa.cjs')({win,app,backend:()=>backend,request,diagnostics,ready:()=>ready,root:ROOT});
  if(process.env.XAL_QA_PAGES)return require('./pages-qa.cjs')({win,app,backend:()=>backend,request,diagnostics,ready:()=>ready,root:ROOT});
  if(process.env.XAL_QA_SHAPES)return require('./shapes-qa.cjs')({win,app,backend:()=>backend,request,diagnostics,ready:()=>ready,root:ROOT});
  if(process.env.XAL_QA_TRAINCHECK)return require('./traincheck-qa.cjs')({win,app,backend:()=>backend,request,diagnostics,ready:()=>ready,root:ROOT});
  await require('./studio-qa.cjs')({win,app,backend:()=>backend,request,ready:()=>ready,root:ROOT});
}
