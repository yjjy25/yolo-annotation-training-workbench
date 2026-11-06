/* WiFi capture page: live preview, continuous capture and direct dataset import.
 * The page never opens a socket; api.maixcam talks to the main process over IPC.
 * globals used here come from studio.js: state, toast, update, loadImages,
 * galleryKey, rpc (top-level let/function declarations share the global scope).
 */
(() => {
 const api=window.workbench,$=s=>document.querySelector(s),byId=id=>document.getElementById(id);
 let current={},busy=false,addressTouched=false,lastImportToast=0;
 const controls=['maixcam-connect','maixcam-disconnect','maixcam-start','maixcam-stop','maixcam-single','maixcam-flush'];

 function render(){
  const s=current||{},connected=!!s.connected,saving=!!s.saving,ready=!!s.ready,project=!!s.projectRoot;
  const address=byId('maixcam-address');
  if(!addressTouched&&document.activeElement!==address&&address.value!==(s.address||''))address.value=s.address||'';
  const interval=byId('maixcam-interval');
  if(document.activeElement!==interval&&interval.value!==String(s.interval??0.5))interval.value=String(s.interval??0.5);
  address.disabled=connected||busy;
  interval.disabled=saving||busy;
  const enabled={
   'maixcam-connect':!busy&&!connected,
   'maixcam-disconnect':!busy&&connected,
   'maixcam-start':!busy&&connected&&!saving&&ready&&project,
   'maixcam-stop':!busy&&saving,
   'maixcam-single':!busy&&connected&&ready&&project,
   'maixcam-flush':!busy&&s.staged>0&&ready&&project
  };
  for(const id of controls)byId(id).disabled=!enabled[id];
  byId('maixcam-link').textContent=saving?'正在采集':connected?'已连接':'未连接';
  byId('maixcam-preview-empty').hidden=connected;
  byId('maixcam-stat-captured').textContent=String(s.captured||0);
  byId('maixcam-stat-imported').textContent=String(s.imported||0);
  byId('maixcam-stat-staged').textContent=String(s.staged||0);
  byId('maixcam-stat-total').textContent=String(state.project?.counts?.total||0);
  const device=s.device&&typeof s.device==='object'?s.device:null;
  byId('maixcam-device').textContent=device?`相机 ${device.width||'?'}×${device.height||'?'} · ${device.fps||'?'} FPS · JPEG 质量 ${device.quality||'?'} · 帧号 ${device.sequence??'—'}`:'';
  byId('maixcam-project-note').textContent=project?`采集的照片直接进入项目「${s.project||'当前项目'}」的 images 目录，完成后即可在“数据与标注”里打开标注。`:'请先新建或打开项目：采集的照片会直接进入该项目的数据集。';
  byId('maixcam-message').textContent=s.message||(connected?(saving?'正在按设定间隔采集并写入当前项目…':'连接正常，设置间隔后即可开始采集。'):'请先在 MaixCAM 上运行板端采集脚本，再填写设备 IP 连接。');
 }

 async function refresh(){
  try{current=await api.maixcam.state();}catch(error){current={...current,message:error.message};}
  render();
 }
 async function run(job){
  if(busy)return;busy=true;render();
  try{await job();}catch(error){toast(error.message);current={...current,message:error.message};render();}
  finally{busy=false;await refresh();}
 }
 async function afterImport(payload){
  // Import happens in the main process through the regular import_images RPC.
  // Refresh both the project counters and the gallery so photos are markable
  // immediately, exactly as with a manual folder import.
  try{
   galleryKey='';
   await api.state().then(update);
   await loadImages();
  }catch(error){console.warn('MaixCAM gallery refresh failed',error);}
  if(payload?.count&&Date.now()-lastImportToast>5000){
   toast(`已把 ${payload.count} 张照片加入数据集${payload.skipped?`，跳过 ${payload.skipped} 张重复图片`:''}。`);
   lastImportToast=Date.now();
  }
  await refresh();
 }

 api.maixcam.onEvent(({type,payload})=>{
  if(type==='frame'){
   const image=byId('maixcam-image');
   if(payload?.url)image.src=payload.url;else image.removeAttribute('src');
   return;
  }
  if(type==='status'){current=payload;render();return;}
  if(type==='error'){current={...current,message:payload?.message||''};render();return;}
  if(type==='imported'){void afterImport(payload);}
 });

 byId('maixcam-address').addEventListener('input',()=>{addressTouched=true;});
 byId('maixcam-connect').onclick=()=>run(()=>api.maixcam.connect(byId('maixcam-address').value.trim()));
 byId('maixcam-disconnect').onclick=()=>run(()=>api.maixcam.disconnect());
 byId('maixcam-start').onclick=()=>run(()=>api.maixcam.start(byId('maixcam-interval').value));
 byId('maixcam-stop').onclick=()=>run(async()=>{await api.maixcam.stop();toast('采集已停止，剩余照片已加入数据集。');});
 byId('maixcam-single').onclick=()=>run(async()=>{await api.maixcam.single();toast('当前画面已加入数据集。');});
 byId('maixcam-flush').onclick=()=>run(async()=>{await api.maixcam.flush();toast('暂存照片已尝试入库。');});
 byId('maixcam-refresh').onclick=()=>run(async()=>{await refresh();});
 byId('maixcam-folder').onclick=()=>api.maixcam.folder().catch(error=>toast(error.message));
 window.maixcam={refresh,sync:render};
 void refresh();
})();
