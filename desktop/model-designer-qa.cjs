module.exports=async({win,app,backend,request,ready})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{nativeImage}=require('electron');
 const folder=process.env.XAL_QA_DESIGN_ROOT,report={checks:[],errors:[]};fs.mkdirSync(folder,{recursive:true});
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async fn=>{const end=Date.now()+90000;while(Date.now()<end){if(await fn())return;await pause(100);}throw Error('design UI timeout');};
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
 win.webContents.on('console-message',(_e,level,message)=>{if(level>=2)report.errors.push(message);});
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev("!!document.getElementById('design-inspect').onclick"));
  win.show();win.focus();
  await request('create_project',{root:path.join(folder,'project'),name:'结构设计验收',task:'detect',classes:['object']});
  const images=path.join(folder,'images');fs.mkdirSync(images);
  for(let i=0;i<4;i++){
   const bytes=Buffer.alloc(64*64*4);for(let j=0;j<bytes.length;j+=4){bytes[j]=30+i*50;bytes[j+1]=60;bytes[j+2]=150;bytes[j+3]=255;}
   const file=path.join(images,`image${i}.png`);fs.writeFileSync(file,nativeImage.createFromBitmap(bytes,{width:64,height:64}).toPNG());
   await request('import_images',{paths:[file]});
   await request('save_annotation',{name:path.basename(file),annotation:{imageWidth:64,imageHeight:64,shapes:[{label:'object',shape_type:'rectangle',points:[[10,10],[40,10],[40,40],[10,40]],flags:{}}],flags:{}},base_hash:null,checked:true});
  }
  await ev('api.state().then(update)');await ev("go('design')");
  if(process.env.XAL_QA_DESIGN_TEMPLATE){
   const id=process.env.XAL_QA_DESIGN_TEMPLATE,catalog=await request('model_design_catalog');
   const family=catalog.families.find(f=>f.variants.some(v=>v.id===id));
   await wait(()=>ev("document.getElementById('design-family').options.length===5"));
   await ev("document.getElementById('design-family').value="+JSON.stringify(family.id)+";document.getElementById('design-family').dispatchEvent(new Event('change'));document.getElementById('design-template').value="+JSON.stringify(id)+";document.getElementById('design-template').dispatchEvent(new Event('change'))");
  }
  await ev("document.getElementById('design-size').value='64';document.getElementById('design-inspect').click()");
  await wait(()=>ev("document.getElementById('design-status').textContent.includes('已加载真实结构')&&!document.getElementById('design-inspect').disabled"));
  check('native graph and leaf operators render',await ev("document.querySelectorAll('#design-graph .design-node').length>20&&document.getElementById('design-layers').options.length>0&&[...document.getElementById('design-layers').options].every(o=>o.value.startsWith('model.0.'))"));
  report.beforeApply=await ev("({status:document.getElementById('design-status').textContent,apply:document.getElementById('design-apply').disabled})");
  await ev("document.getElementById('design-layers').value='model.0.conv';document.getElementById('design-layers').dispatchEvent(new Event('change'));document.getElementById('design-value').value='5';document.getElementById('design-value').dispatchEvent(new Event('change'));document.getElementById('design-apply').click()");
  await wait(()=>ev("document.getElementById('design-status').textContent.includes('已加载真实结构')&&!document.getElementById('design-inspect').disabled"));
  check('kernel change appears in diff and source hash exists',await ev("document.getElementById('design-diff').textContent.includes('→ 5')&&document.getElementById('design-source').textContent.includes('sha256')"));
  await ev("document.getElementById('design-check').click()");
  await wait(()=>ev("!document.getElementById('design-train').disabled"));
  check('forward and backward check saved immutable revision',await ev("document.getElementById('design-revision').textContent.includes('rev_')"));
  await ev("document.querySelector('#page-design .design-grid').scrollIntoView({block:'start'})");
  await pause(500);
  fs.writeFileSync(path.join(folder,'designer.png'),(await win.webContents.capturePage()).toPNG());
  await ev("document.getElementById('design-refresh').click()");
  await wait(()=>ev("document.getElementById('design-history').options.length>0"));
  await ev("document.getElementById('design-load').click()");
  await wait(()=>ev("document.getElementById('design-status').textContent.includes('已载入历史修订')"));
  check('saved revision reloads with its recorded design and source',await ev("document.getElementById('design-diff').textContent.includes('→ 5')"));
  await ev("document.getElementById('design-train').click()");
  await wait(()=>ev("page==='train'&&document.getElementById('train-model').value.endsWith('model.yaml')"));
  check('checked design is selected on training page with matching input size',await ev("document.getElementById('train-imgsz').value==='64'"));
  await ev("document.getElementById('train-epochs').value='1';document.getElementById('train-batch').value='2';document.getElementById('train-workers').value='0';document.getElementById('training-form').requestSubmit()");
  await wait(()=>ev("['completed','failed'].includes(state.trainingInfo?.status)"));
  report.training=await ev('state.trainingInfo');
  check('desktop starts design training and completes a real epoch',report.training.status==='completed');
  check('design training preserves explicit scale without a filename guessing warning',report.training.logs.some(s=>s.includes('结构设计已加载'))&&!report.training.logs.some(s=>s.includes('no model scale passed')));
  check('training snapshot retains source files',fs.existsSync(path.join(report.training.run,'design_snapshot','sources','manifest.json')));
 }catch(error){report.errors.push(error.stack);report.dom=await ev("({status:document.getElementById('design-status').textContent,apply:document.getElementById('design-apply').disabled,inspect:document.getElementById('design-inspect').disabled,layer:document.getElementById('design-layers').value,value:document.getElementById('design-value').value})");}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
