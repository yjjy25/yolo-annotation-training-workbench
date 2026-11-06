module.exports=async({win,app,backend,request,ready})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{nativeImage}=require('electron');
 const folder=process.env.XAL_QA_DESIGN_ROOT,report={checks:[],errors:[]};fs.mkdirSync(folder,{recursive:true});
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async fn=>{const end=Date.now()+90000;while(Date.now()<end){if(await fn())return;await pause(100);}throw Error('design UI timeout');};
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
 win.webContents.on('console-message',(_e,level,message)=>{if(level>=2)report.errors.push(message);});
 if(process.env.XAL_QA_SPACE_PREVIEW){
  try{
   await wait(()=>Promise.resolve(ready()));await wait(()=>ev("!!document.getElementById('design-inspect').onclick"));
   win.show();win.focus();
   const source=process.env.XAL_QA_SPACE_PREVIEW;await request('open_project',{path:path.join(source,'project/project.json')});
   await ev("api.state().then(update)");await ev("go('design');document.getElementById('design-refresh').click()");
   await wait(()=>ev("document.getElementById('design-history').options.length>0"));await ev("document.getElementById('design-load').click()");
   await wait(()=>ev("document.getElementById('design-status').textContent.includes('已载入历史修订')"));
   await ev("document.getElementById('design-space').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));for(let i=0;i<2;i++)document.getElementById('design-space').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));document.getElementById('design-unit').value='model.2.m.0.cv1';document.getElementById('design-unit').dispatchEvent(new Event('change'));document.getElementById('design-zoom').value='fit';document.getElementById('design-zoom').dispatchEvent(new Event('change'))");
   check('current input and output remain visible for an internal member',await ev("document.getElementById('design-current-path').textContent.includes('m › 0 › cv1 › conv')&&document.getElementById('design-output-shape').textContent.includes('通道')"));
   if(process.env.XAL_QA_HIERARCHY){
    await ev("document.getElementById('design-space').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));for(let i=0;i<4;i++)document.getElementById('design-space').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));document.getElementById('design-space-expand').click()");await pause(200);
    check('compound module expands into actual operator hierarchy',await ev("!document.getElementById('design-layer-tree').hidden&&document.querySelector('[data-layer-path=\"model.4.m.0\"]')&&document.querySelector('[data-layer-path=\"model.4.m.1\"]')"));
    check('actual counts expose multiple layers instead of one cube',await ev("document.getElementById('design-space-count').textContent.includes('18 个算子')"));
    await ev("document.querySelector('[data-layer-path=\"model.4.m.1\"]').click()");await pause(150);
    check('entering a repeat block scopes the 3D hierarchy',await ev("document.getElementById('design-space-caption').textContent.includes('model.4.m.1 Bottleneck')"));
    await ev("document.querySelector('[data-layer-path=\"model.4.m.1.cv2\"]').click()");await pause(150);
    check('a Conv wrapper shows its three actual operators',await ev("document.getElementById('design-space-count').textContent.includes('3 个算子')&&document.querySelector('[data-layer-path=\"model.4.m.1.cv2.bn\"]')"));
    await ev("document.querySelector('[data-layer-path=\"model.4.m.1.cv2.bn\"]').click()");
    check('selecting normalization targets the exact read-only leaf',await ev("document.getElementById('design-current-path').textContent.includes('m › 1 › cv2 › bn')&&document.getElementById('design-value').disabled&&document.getElementById('design-output-shape').textContent.includes('通道')"));
    await ev("document.querySelector('[data-layer-path=\"model.4.m.1.cv2.act\"]').click()");
    check('selecting activation opens the actual editable leaf',await ev("document.getElementById('design-current-path').textContent.includes('m › 1 › cv2 › act')&&document.getElementById('design-field').textContent==='激活函数'"));
    const plate=await ev("(async()=>{const report=await rpc('model_design_read',{revision:document.getElementById('design-history').value}),scene=ModelSpace.detailScene(report.modified,'model.4.m.1.cv2',report.shapes),canvas=document.getElementById('design-space'),r=canvas.getBoundingClientRect(),camera=ModelSpace.fitCamera(scene,r.width,r.height),p=ModelSpace.project(scene.items.find(n=>n.path.endsWith('.bn')).position,camera,r.width,r.height);return {x:Math.round(r.x+p[0]),y:Math.round(r.y+p[1])};})()");
    win.webContents.sendInputEvent({type:'mouseDown',x:plate.x,y:plate.y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:plate.x,y:plate.y,button:'left',clickCount:1});await pause(150);
    check('clicking an actual 3D plate selects its precise BN layer',await ev("document.getElementById('design-current-path').textContent.includes('m › 1 › cv2 › bn')"));
    await ev("document.querySelector('[data-layer-path=\"model.4.m.1.cv2.act\"]').click()");
    await pause(200);fs.writeFileSync(path.join(folder,'three-operator-stack.png'),(await win.webContents.capturePage()).toPNG());
    await ev("document.getElementById('design-space-up').click();document.getElementById('design-space-up').click();document.getElementById('design-space-up').click()");await pause(250);
    check('up-navigation restores the full compound module',await ev("document.getElementById('design-space-caption').textContent.startsWith('model.4 C2f')"));
   }
   win.show();await pause(200);fs.writeFileSync(path.join(folder,'structure-3d.png'),(await win.webContents.capturePage()).toPNG());
   const workspace=await ev("{const r=document.querySelector('#page-design .design-grid').getBoundingClientRect();({x:Math.floor(r.x),y:Math.floor(r.y),width:Math.floor(r.width),height:Math.floor(r.height)})}");
   fs.writeFileSync(path.join(folder,'structure-workspace.png'),(await win.webContents.capturePage(workspace)).toPNG());
   await ev("api.theme('light')");await pause(200);fs.writeFileSync(path.join(folder,'structure-3d-light.png'),(await win.webContents.capturePage()).toPNG());
   check('light theme repaint follows application theme',await ev("document.documentElement.dataset.theme==='light'"));
   await ev("api.theme('dark')");win.setContentSize(1100,800);await pause(200);await ev("document.getElementById('design-zoom').value='fit';document.getElementById('design-zoom').dispatchEvent(new Event('change'))");await pause(150);
   check('narrow workspace keeps the IO summary inside viewport',await ev("{const a=document.getElementById('design-output-shape').getBoundingClientRect();a.left>=0&&a.right<=innerWidth&&a.top>=0&&a.bottom<=innerHeight}"));
   fs.writeFileSync(path.join(folder,'structure-3d-narrow.png'),(await win.webContents.capturePage()).toPNG());
   if(process.env.XAL_QA_HIERARCHY){await ev("document.getElementById('design-space-overview').click()");await pause(200);check('overview remains available after expanding nested layers',await ev("document.getElementById('design-layer-tree').hidden"));fs.writeFileSync(path.join(folder,'network-overview.png'),(await win.webContents.capturePage()).toPNG());}
  }catch(error){report.errors.push(error.stack);}
  fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);return;
 }
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
  check('kernel change appears in diff and source hash exists',await ev("/→ 5|\"kernel\":5/.test(document.getElementById('design-diff').textContent)&&document.getElementById('design-source').textContent.includes('sha256')"));
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
  check('saved revision reloads with its recorded design and source',await ev("/→ 5|\"kernel\":5/.test(document.getElementById('design-diff').textContent)"));
  if(process.env.XAL_QA_GEOMETRY){
   await ev("document.getElementById('design-auto-measure').checked=false;document.getElementById('design-initialize').click()");
   await wait(()=>ev("!document.getElementById('design-inspect').disabled&&document.getElementById('design-diff').textContent.includes('结构未修改')"));
   await ev("document.getElementById('design-graph').querySelectorAll('.design-node')[5].dispatchEvent(new MouseEvent('click',{bubbles:true}))");
   await ev("document.getElementById('design-layers').value='model.5.conv';document.getElementById('design-layers').dispatchEvent(new Event('change'));document.getElementById('design-policy').value='manual';document.getElementById('design-policy').dispatchEvent(new Event('change'));document.getElementById('design-stride').value='1';document.getElementById('design-stride').dispatchEvent(new Event('change'));document.getElementById('design-apply').click()");
   await wait(()=>ev("!document.getElementById('design-inspect').disabled&&!document.getElementById('design-conflict').hidden"));
   check('concat conflict exposes actual sources and blocks training',await ev("document.getElementById('design-conflict-detail').textContent.includes('model.14')&&document.getElementById('design-conflict-detail').textContent.includes('model.4')&&document.getElementById('design-train').disabled"));
   await ev("document.getElementById('design-conflict-locate').click()");
   check('conflict can be located on graph',await ev("document.getElementById('design-selection').textContent.includes('14')"));
   fs.writeFileSync(path.join(folder,'geometry-conflict.png'),(await win.webContents.capturePage()).toPNG());
   await ev("document.getElementById('design-undo').click()");
   await wait(()=>ev("!document.getElementById('design-inspect').disabled&&document.getElementById('design-conflict').hidden"));
   check('undo restores valid geometry and clears conflict',true);
   await ev("document.getElementById('design-graph').querySelectorAll('.design-node')[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));document.getElementById('design-layers').value='model.0.conv';document.getElementById('design-layers').dispatchEvent(new Event('change'));document.getElementById('design-policy').value='manual';document.getElementById('design-policy').dispatchEvent(new Event('change'));document.getElementById('design-stride').value='1';document.getElementById('design-stride').dispatchEvent(new Event('change'));document.getElementById('design-check').click()");
   await wait(()=>ev("!document.getElementById('design-train').disabled"));
   check('check captures pending geometry and saves recalibrated revision',await ev("document.getElementById('design-diff').textContent.includes('\"stride\":1')"));
   const revisions=await request('model_design_revisions');
   const geometryRevision=revisions.map(r=>JSON.parse(fs.readFileSync(path.join(folder,'project/model_designs/revisions',r.id,'report.json'),'utf8'))).find(r=>r.geometry_checks?.strides[0]===4);
   check('saved report verifies actual detection strides',geometryRevision?.geometry_checks.strides.join(',')==='4,8,16');
   fs.writeFileSync(path.join(folder,'geometry-valid.png'),(await win.webContents.capturePage()).toPNG());
  }
  if(process.env.XAL_QA_SPACE){
   check('3D network is the default and local IO is visible',await ev("!document.getElementById('design-space-host').hidden&&document.getElementById('design-input-shape').textContent.includes('通道')&&document.getElementById('design-output-shape').textContent.includes('通道')"));
   await ev("document.getElementById('design-space').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));document.getElementById('design-space').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));document.getElementById('design-space').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");
   check('3D keyboard selection identifies the actual C2f module',await ev("document.getElementById('design-current-path').textContent.includes('model.2 C2f')"));
   const unit=await ev("document.getElementById('design-unit').value");
   check('specific member path is available instead of abstract layer tiles',unit==='model.2.cv1');
   const measured=(await request('model_design_status')).result.shapes['model.2.cv1.conv'];
   const expected=measured.input[0];
   check('selected leaf input matches backend native measurement',await ev("document.getElementById('design-input-shape').textContent.includes("+JSON.stringify(`${expected[2]} × ${expected[3]} · ${expected[1]} 通道`)+")"));
   await ev("document.getElementById('design-unit').value='model.2.m.0.cv1';document.getElementById('design-unit').dispatchEvent(new Event('change'))");
   check('internal member selection updates full position and measured IO',await ev("document.getElementById('design-current-path').textContent.includes('m › 0 › cv1 › conv')&&document.getElementById('design-output-shape').textContent.includes('通道')"));
   await ev("document.getElementById('design-view-2d').click()");
   check('2D fallback remains available',await ev("document.getElementById('design-space-host').hidden&&!document.getElementById('design-graph').parentElement.hidden"));
   await ev("document.getElementById('design-view-3d').click()");await pause(100);
   const before=(await win.webContents.capturePage()).toPNG();
   const rect=await ev("{const r=document.getElementById('design-space').getBoundingClientRect();({x:Math.round(r.x+40),y:Math.round(r.y+40)})}");
   win.webContents.sendInputEvent({type:'mouseDown',x:rect.x,y:rect.y,button:'left',clickCount:1});
   win.webContents.sendInputEvent({type:'mouseMove',x:rect.x+70,y:rect.y+25,movementX:70,movementY:25});
   win.webContents.sendInputEvent({type:'mouseUp',x:rect.x+70,y:rect.y+25,button:'left',clickCount:1});
   await pause(100);check('3D drag changes the projected scene',!before.equals((await win.webContents.capturePage()).toPNG()));
   await ev("document.getElementById('design-zoom').value='fit';document.getElementById('design-zoom').dispatchEvent(new Event('change'))");await pause(100);
   fs.writeFileSync(path.join(folder,'tensor-3d.png'),(await win.webContents.capturePage()).toPNG());
   await ev("api.theme('light')");await pause(150);
   fs.writeFileSync(path.join(folder,'tensor-3d-light.png'),(await win.webContents.capturePage()).toPNG());
   await ev("api.theme('dark')");
   await ev("document.getElementById('design-auto-measure').checked=false;document.getElementById('design-size').value='128';document.getElementById('design-size').dispatchEvent(new Event('input'))");
   check('stale IO disappears immediately on input change',await ev("document.getElementById('design-input-shape').textContent==='待重新实测'&&document.getElementById('design-train').disabled"));
   await ev("document.getElementById('design-size').value='64';document.getElementById('design-size').dispatchEvent(new Event('input'));document.getElementById('design-check').click()");
   await wait(()=>ev("!document.getElementById('design-train').disabled"));
  }
  await ev("document.getElementById('design-train').click()");
  await wait(()=>ev("page==='train'&&document.getElementById('train-model').value.endsWith('model.yaml')"));
  check('checked design is selected on training page with matching input size',await ev("document.getElementById('train-imgsz').value==='64'"));
  await ev("document.getElementById('train-epochs').value='1';document.getElementById('train-batch').value='2';document.getElementById('train-workers').value='0';document.getElementById('training-form').requestSubmit()");
  await wait(()=>ev("['completed','failed'].includes(state.trainingInfo?.status)"));
  report.training=await ev('state.trainingInfo');
  check('desktop starts design training and completes a real epoch',report.training.status==='completed');
  check('design training preserves explicit scale without a filename guessing warning',report.training.logs.some(s=>s.includes('结构设计已加载'))&&!report.training.logs.some(s=>s.includes('no model scale passed')));
  check('training snapshot retains source files',fs.existsSync(path.join(report.training.run,'design_snapshot','sources','manifest.json')));
 }catch(error){report.errors.push(error.stack);report.dom=await ev("({status:document.getElementById('design-status').textContent,apply:document.getElementById('design-apply').disabled,inspect:document.getElementById('design-inspect').disabled,layer:document.getElementById('design-layers').value,value:document.getElementById('design-value').value,conflictHidden:document.getElementById('design-conflict').hidden,conflict:document.getElementById('design-conflict-detail').textContent,page})");try{report.lastDesignJob=await request('model_design_status');}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
