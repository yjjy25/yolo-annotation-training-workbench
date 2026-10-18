module.exports=async({win,app,backend,request,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{nativeImage}=require('electron');
 const folder=process.env.XAL_QA_SPLITCOUNTS_ROOT,report={checks:[],errors:[]};fs.mkdirSync(folder,{recursive:true});
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async fn=>{const end=Date.now()+40000;while(Date.now()<end){if(await fn())return;await pause(50);}throw Error('UI timeout');};
 const check=(text,value)=>{assert.ok(value,text);report.checks.push(text);};
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.videoTracking'));win.show();win.focus();
  const project=path.join(folder,'project'),source=path.join(folder,'source');fs.mkdirSync(source);
  await request('create_project',{root:project,name:'划分数量验证',task:'detect',classes:['object']});
  const paths=[];
  for(let i=0;i<86;i++){
   const bytes=Buffer.alloc(64*64*4);for(let p=0;p<bytes.length;p+=4){bytes[p]=i+30;bytes[p+1]=110;bytes[p+2]=180;bytes[p+3]=255;}
   const filename=path.join(source,`image_${String(i).padStart(3,'0')}.png`);
   fs.writeFileSync(filename,nativeImage.createFromBitmap(bytes,{width:64,height:64}).toPNG());paths.push(filename);
  }
  await request('import_images',{paths});
  const names=paths.map(p=>path.basename(p)),annotation={imageWidth:64,imageHeight:64,shapes:[{label:'object',shape_type:'rectangle',points:[[5,5],[50,5],[50,50],[5,50]],flags:{}}],flags:{}};
  for(const name of names.slice(0,23))await request('save_annotation',{name,annotation,base_hash:null,checked:true});
  await ev('api.state().then(update)');await ev("go('data')");await ev('refreshSplitPreview()');
  await wait(()=>ev("$('#split-summary').textContent.includes('已审核 23 张')"));
  check('initial 23 reviewed images render their actual split',await ev("$('#split-summary').textContent.includes('已审核 23 张')"));
  for(const name of names.slice(23))await request('save_annotation',{name,annotation,base_hash:null,checked:true});
  await ev('api.state().then(update)');await ev('refreshSplitPreview()');
  await wait(()=>ev("$('#split-summary').textContent.includes('已审核 86 张')"));
  const preview=await request('split_preview',{split_mode:'ratio',split_ratio:20,split_count:1,split_seed:42});report.preview=preview;
  check('23 to 86 reviewed images invalidates preview without changing split options',await ev("$('#count-checked').textContent==='86'&&$('#split-summary').textContent.includes('已审核 86 张')"));
  check('split counts include all reviewed images',preview.train+preview.val===86);
  await ev("go('train')");await ev('refreshSplitPreview()');
  check('training page displays train, validation and independent test counts',await ev(`$('#training-split-summary').textContent.includes('训练集 ${preview.train} 张')&&$('#training-split-summary').textContent.includes('验证集 ${preview.val} 张')&&$('#training-split-summary').textContent.includes('测试集 0 张')`));
  await request('start_training',{model:path.join(root,'.runtime','pretrained','yolov8n.pt'),device:'cpu',epochs:1,batch:1,imgsz:64,workers:0,split_ratio:20});
  await request('stop_training');await ev('api.state().then(update)');
  await wait(()=>ev('!!state.trainingInfo.dataset_counts'));
  report.frozen=await ev('state.trainingInfo.dataset_counts');
  check('training counts come from the actual frozen manifest',report.frozen.train===preview.train&&report.frozen.val===preview.val&&report.frozen.test===0);
  const name=names.at(-1),label=await request('load_annotation',{name});await request('save_annotation',{name,annotation:label.annotation,base_hash:label.base_hash,checked:false});
  await ev('api.state().then(update)');await ev('refreshSplitPreview()');
  await wait(()=>ev("$('#training-split-summary').textContent.includes('已审核 85 张')"));
  check('new current preview changes while training snapshot counts remain fixed',await ev(`$('#training-split-summary').textContent.includes('已审核 85 张')&&$('#training-used-split').textContent.includes('训练集 ${preview.train} 张')`));
  fs.writeFileSync(path.join(folder,'training-counts.png'),(await win.webContents.capturePage()).toPNG());
 }catch(error){report.errors.push(error.stack);try{fs.writeFileSync(path.join(folder,'failure.png'),(await win.webContents.capturePage()).toPNG());}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
