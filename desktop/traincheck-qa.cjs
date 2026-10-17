/* Starts a real training run from the UI and reports whether Ultralytics accepts
 * the arguments (the "Unsupported training arguments: conf, iou" regression). */
module.exports=async function({win,app,backend,request,diagnostics,ready,root}){
 const fs=require('node:fs'),path=require('node:path');
 const runtime=path.join(root,'.runtime');
 const out=path.join(runtime,'traincheck-check.json');
 const result={steps:[],errors:[]};
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const evaluate=s=>win.webContents.executeJavaScript(s,true);
 const wait=async(t,ms,l)=>{const e=Date.now()+ms;while(Date.now()<e){if(await t())return true;await pause(200);}throw new Error('timeout '+l);};
 const shot=async n=>fs.writeFileSync(path.join(runtime,n),(await win.webContents.capturePage()).toPNG());
 try{
  await wait(()=>Promise.resolve(ready()),60000,'ready');
  await wait(()=>evaluate('!!window.editor'),20000,'editor');
  win.show();win.focus();await pause(800);
  // A fresh project with reviewed circles/boxes so a snapshot can be built.
  const project=path.join(runtime,'traincheck-'+Date.now());
  await request('create_project',{name:'训练参数验收',task:'detect',classes:['猫'],root:project,source:path.join(runtime,'smoke-v2','detect','images'),preset:'human'});
  await pause(2500);
  await evaluate(`(async()=>{
   const response=await window.workbench.images({page:0,filter:'all',search:'',dpr:1,size:24});
   for(const item of response.items){
    await window.workbench.rpc('save_annotation',{name:item.name,annotation:{shapes:[{label:'猫',shape_type:'rectangle',
      points:[[10,10],[60,10],[60,60],[10,60]],group_id:null,flags:{},difficult:false,description:'',attributes:{}}],flags:{}},
      base_hash:(await window.workbench.rpc('load_annotation',{name:item.name})).base_hash,checked:true});
   }
   return undefined;
  })()`);
  await pause(1500);
  await evaluate("go('train')");await pause(2000);
  // Set the thresholds, then start training with tiny settings.
  await evaluate(`(()=>{
   document.querySelector('#train-iou').value='0.45';
   document.querySelector('#train-confidence').value='0.35';
   document.querySelector('#train-epochs').value='1';
   document.querySelector('#train-batch').value='1';
   document.querySelector('#train-imgsz').value='64';
   document.querySelector('#train-workers').value='0';
   document.querySelector('#train-patience').value='1';
   document.querySelector('#train-device').value='cpu';
   return undefined;
  })()`);
  await evaluate("document.querySelector('#training-form').requestSubmit()");
  // Wait for the log to say something other than "starting".
  const logs=[];
  for(let i=0;i<90;i++){
   await pause(2000);
   const text=await evaluate("document.querySelector('#training-log').textContent");
   if(logs.at(-1)!==text)logs.push(text.slice(-400));
   const status=await evaluate("document.querySelector('#training-status').textContent");
   if(/失败|完成|已停止/.test(status))break;
   if(/Unsupported training arguments/.test(text))break;
   if(/Epoch|epochs completed|box_loss|Starting training/.test(text))break;
  }
  result.status=await evaluate("document.querySelector('#training-status').textContent");
  result.log=(await evaluate("document.querySelector('#training-log').textContent")).slice(-900);
  await shot('traincheck.png');
  // The payload written for the worker is the ground truth.
  const runs=fs.existsSync(path.join(project,'runs'))?fs.readdirSync(path.join(project,'runs')).filter(n=>n.endsWith('.json')):[];
  result.payloads=[];
  for(const name of runs){
   const payload=JSON.parse(fs.readFileSync(path.join(project,'runs',name),'utf8'));
   result.payloads.push({name,conf:payload.args.conf,iou:payload.args.iou,keys:Object.keys(payload.args).length,epochs:payload.args.epochs});
  }
  await request('stop_training').catch(()=>{});
 }catch(error){result.errors.push(error.stack);try{await shot('traincheck-failure.png');}catch{}}
 fs.writeFileSync(out,JSON.stringify(result,null,2));
 try{await request('prepare_exit');}catch{}
 setTimeout(()=>{if(backend()?.exitCode===null)backend().kill();app.exit(0);},900);
};
