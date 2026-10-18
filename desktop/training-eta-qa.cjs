module.exports=async({win,app,backend,request,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{nativeImage}=require('electron');
 const folder=process.env.XAL_QA_TRAININGETA_ROOT,report={checks:[],errors:[]};fs.mkdirSync(folder,{recursive:true});
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async fn=>{const end=Date.now()+90000;while(Date.now()<end){if(await fn())return;await pause(80);}throw Error('UI timeout');};
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.videoTracking'));win.show();win.focus();
  const project=path.join(folder,'project'),source=path.join(folder,'source');fs.mkdirSync(source);
  await request('create_project',{root:project,name:'训练进度与完成时间',task:'detect',classes:['object']});
  const paths=[];for(let i=0;i<8;i++){
   const data=Buffer.alloc(128*128*4);for(let p=0;p<data.length;p+=4){data[p]=i*20;data[p+1]=80;data[p+2]=170;data[p+3]=255;}
   const name=path.join(source,`photo_${i}.png`);fs.writeFileSync(name,nativeImage.createFromBitmap(data,{width:128,height:128}).toPNG());paths.push(name);
  }
  await request('import_images',{paths});for(const file of paths)await request('save_annotation',{name:path.basename(file),base_hash:null,checked:true,annotation:{imageWidth:128,imageHeight:128,shapes:[{label:'object',shape_type:'rectangle',points:[[20,20],[100,20],[100,100],[20,100]],flags:{}}],flags:{}}});
  await ev('api.state().then(update)');await ev("go('train')");
  await ev("window.__progressEvents=[];api.onState(s=>{if(s.training_info?.progress)window.__progressEvents.push(s.training_info.progress)});void 0");
  await request('start_training',{model:path.join(root,'.runtime','pretrained','yolov8n.pt'),device:'cpu',epochs:6,batch:2,imgsz:64,workers:0,patience:0});
  await wait(()=>ev("!!state.trainingInfo?.progress&&state.trainingInfo.progress.completed>0&&state.trainingInfo.status==='training'"));
  report.live=await ev("({progress:state.trainingInfo.progress,bar:$('#training-progress-fill').style.width,text:$('#training-progress-text').textContent})");
  check('real training reports batch progress before the first epoch finishes',await ev('window.__progressEvents.some(p=>p.completed>0&&p.completed<1)')&&parseFloat(report.live.bar)>0);
  await wait(()=>ev("state.trainingInfo?.progress?.eta_seconds>0&&$('#training-eta').textContent.includes('预计完成')"));
  report.estimate=await ev("({progress:state.trainingInfo.progress,text:$('#training-eta').textContent,elapsed:$('#training-elapsed').textContent})");
  check('ETA appears after a real epoch including validation',report.estimate.progress.completed>=1&&report.estimate.text.includes('预计剩余'));
  await ev("$('#training-progress').scrollIntoView({block:'center'});void 0");await pause(150);fs.writeFileSync(path.join(folder,'training-eta.png'),(await win.webContents.capturePage()).toPNG());
  await wait(()=>ev("['completed','failed'].includes(state.trainingInfo?.status)"));
  check('real training completes successfully',await ev("state.trainingInfo.status==='completed'"));
  check('completion reaches 100 percent and clears estimates',await ev("$('#training-progress-fill').style.width==='100%'&&$('#training-eta').textContent===''"));
  report.final=await ev('state.trainingInfo.progress');
 }catch(error){report.errors.push(error.stack);try{fs.writeFileSync(path.join(folder,'failure.png'),(await win.webContents.capturePage()).toPNG());}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
