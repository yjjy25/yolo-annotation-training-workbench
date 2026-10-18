/* Isolated release verification; runs only with explicit test environment flags. */
module.exports=async({win,app,backend,request,diagnostics,ready,testRoot})=>{
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{nativeImage}=require('electron');
 if(!testRoot||!path.isAbsolute(testRoot))throw new Error('Absolute package test directory required');
 fs.mkdirSync(testRoot,{recursive:true});const report=path.join(testRoot,'report.json'),result={errors:[],tasks:[],started:new Date().toISOString()};
 const device=process.env.XAL_PACKAGE_DEVICE||'cpu';result.device=device;
 const save=()=>fs.writeFileSync(report,JSON.stringify(result,null,2));
 const pause=ms=>new Promise(r=>setTimeout(r,ms)),evaluate=s=>win.webContents.executeJavaScript(s,true);
 const wait=async(test,ms=60000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await test())return;await pause(150);}throw new Error('Package test timed out: '+result.stage);};
 const click=async s=>{const p=await evaluate(`(()=>{const t=document.querySelector(${JSON.stringify(s)});t.scrollIntoView({block:'nearest'});const r=t.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await pause(200);};
 const draw=async(a,b)=>{const p=await evaluate(`(()=>{const r=editor.canvas.getBoundingClientRect();return ${JSON.stringify([a,b])}.map(p=>({x:Math.round(r.x+editor.offset[0]+p[0]*editor.zoom),y:Math.round(r.y+editor.offset[1]+p[1]*editor.zoom)}));})()`);for(const [type,point] of [['mouseMove',p[0]],['mouseDown',p[0]],['mouseMove',p[1]],['mouseUp',p[1]]]){win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await pause(100);}};
 const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 try{
  result.stage='startup';save();await wait(()=>Promise.resolve(ready()));win.show();win.focus();await wait(()=>evaluate('!!window.editor'));
  result.runtime=await diagnostics();result.backendPid=backend().pid;
  if(!result.runtime.source.includes('workbench'))throw new Error('Release did not load its own source');
  const source=path.join(testRoot,'synthetic');fs.mkdirSync(source,{recursive:true});
  for(let n=0;n<6;n++){const bytes=Buffer.alloc(64*64*4);for(let i=0;i<bytes.length;i+=4){bytes[i]=20+n*3;bytes[i+1]=35;bytes[i+2]=65;bytes[i+3]=255;}for(let y=8;y<56;y++)for(let x=6;x<58;x++){const i=(y*64+x)*4;bytes[i]=50+n;bytes[i+1]=150;bytes[i+2]=230;}fs.writeFileSync(path.join(source,'image_'+n+'.png'),nativeImage.createFromBitmap(bytes,{width:64,height:64}).toPNG());}
  for(const task of ['detect','pose']){
   result.stage=task;save();const project=path.join(testRoot,task),classes=task==='pose'?['站立','趴卧']:['猫','狗'];
   await evaluate("go('data')");await request('create_project',{root:project,name:'发行包多实例验收 '+task,task,classes,source,preset:'dog'});
   await pause(300);await click('.nav-item[data-page=editor]');await wait(()=>evaluate(`editor.project?.root===${JSON.stringify(project)}&&!!editor.image`));await pause(350);
   for(let image=0;image<2;image++){
    for(let i=0;i<2;i++){await click('#class-shortcuts button:nth-child('+(i+1)+')');await click('#tool-draw');await draw(i?[34,7]:[5,5],i?[60,58]:[29,57]);}
    await click('#save-annotation');await wait(()=>evaluate('!editor.dirty&&!editor.saving'));
    const annotation=JSON.parse(fs.readFileSync(path.join(project,'annotations','image_'+image+'.json'),'utf8'));
    const boxes=annotation.shapes.filter(s=>s.shape_type==='rectangle');
    if(boxes.length!==2||!classes.every(c=>boxes.some(s=>s.label===c)))throw new Error('Multiple class instances not preserved');
    for(let i=0;i<boxes.length;i++){const a=i?[34,7]:[5,5],b=i?[60,58]:[29,57];if(boxes[i].points[0].some((v,j)=>Math.abs(v-a[j])>1)||boxes[i].points[2].some((v,j)=>Math.abs(v-b[j])>1))throw new Error('Saved box differs from pointer release position: '+JSON.stringify(boxes[i].points));}
    if(task==='pose'&&(new Set(boxes.map(s=>s.group_id)).size!==2||annotation.shapes.filter(s=>s.shape_type==='point').length!==48))throw new Error('Pose groups not independent');
    if(image===0){await pause(300);fs.writeFileSync(path.join(testRoot,task+'.png'),(await win.webContents.capturePage()).toPNG());}
    await wait(()=>evaluate(`editor.name==='image_${image+1}.png'&&!editor.approving`));await pause(200);
   }
   result.stage=task+' training';save();
   const started=await request('start_training',{model:task==='pose'?'yolov8n-pose.pt':'yolov8n.pt',device,epochs:1,batch:2,imgsz:64,workers:0,patience:1,lr0:.01,amp:false});
   await wait(()=>evaluate(`state.training_info?.run===${JSON.stringify(started.run)}&&['completed','failed'].includes(state.training_info?.status)`),180000);
   const training=await evaluate('state.training_info');result.lastTraining=training;if(training.status!=='completed')throw new Error(training.error||'Training failed');
   const weights=path.join(training.run,'weights','best.pt');if(!fs.existsSync(weights))throw new Error('No model produced');
   const labels=fs.readdirSync(path.join(project,'annotations')),before=Object.fromEntries(labels.map(n=>[n,hash(path.join(project,'annotations',n))]));
   await request('predict',{weights,device,confidence:.25});await wait(()=>evaluate('state.predicting'));await wait(()=>evaluate('!state.predicting'),120000);
   if(await evaluate('state.prediction_status')!=='completed')throw new Error('Prediction failed');
   if(fs.readdirSync(path.join(project,'proposals','latest')).filter(n=>n.endsWith('.json')).length!==6)throw new Error('Incomplete proposals');
   if(labels.some(n=>hash(path.join(project,'annotations',n))!==before[n]))throw new Error('Prediction changed formal annotations');
   result.tasks.push({task,classes,multipleInstances:true,training:training.status,weights,proposals:6,originalsUnchanged:true});save();
  }
  result.stage='complete';result.finished=new Date().toISOString();
 }catch(error){result.errors.push(error.stack);try{fs.writeFileSync(path.join(testRoot,'failure.png'),(await win.webContents.capturePage()).toPNG());}catch{}}
 save();try{await request('prepare_exit');}catch{}
 setTimeout(()=>{if(backend()?.exitCode===null)backend().kill();app.exit(result.errors.length?1:0);},700);
};
