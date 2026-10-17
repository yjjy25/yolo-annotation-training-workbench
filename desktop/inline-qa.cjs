/* Exercise retained Qt tools through the Electron image/input bridge. */
module.exports=async({win,app,backend,request,diagnostics,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path');
 const result={errors:[],checks:[]},target=path.join(root,'.runtime','inline-check.json');
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const evaluate=s=>win.webContents.executeJavaScript(s,true);
 const wait=async(test,timeout=25000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await pause(120);}throw new Error('Inline QA timed out: '+result.stage);};
 const clickAt=async p=>{for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(p.x),y:Math.round(p.y)});await pause(220);};
 const click=async s=>clickAt(await evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(s)});target.scrollIntoView({block:'nearest'});const r=target.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`));
 const nativeClick=async r=>clickAt(await evaluate(`(()=>{const p=${JSON.stringify(r)},r=document.querySelector('#inline-frame').getBoundingClientRect(),scale=Math.min(r.width/inlineTools.width,r.height/inlineTools.height);return {x:r.x+(r.width-inlineTools.width*scale)/2+(p[0]+p[2]/2)*scale,y:r.y+(r.height-inlineTools.height*scale)/2+(p[1]+p[3]/2)*scale};})()`));
 const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await pause(220);};
 const screenshot=async name=>{await pause(250);fs.writeFileSync(path.join(root,'文档','界面预览',name),(await win.webContents.capturePage()).toPNG());};
 const check=async name=>{result.stage=name;result.diagnostic=await diagnostics();fs.writeFileSync(target,JSON.stringify(result,null,2));return result.diagnostic.inline;};
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>evaluate('!!window.editor'));win.show();win.focus();
  const prior=JSON.parse(fs.readFileSync(path.join(root,'.runtime','studio-check.json'),'utf8'));
  const sourceProject=prior.tasks.find(t=>t.task==='detect').project;
  if(!path.resolve(sourceProject).startsWith(path.join(root,'.runtime','studio-test')+path.sep))throw new Error('Unsafe QA project');
  const project=path.join(root,'.runtime','studio-test','inline-'+Date.now());fs.mkdirSync(project,{recursive:true});
  for(const name of ['project.json','images','annotations'])fs.cpSync(path.join(sourceProject,name),path.join(project,name),{recursive:true});
  await request('open_project',{path:path.join(project,'project.json')});await pause(400);
  await click('.nav-item[data-page=editor]');await wait(()=>evaluate('!!editor.image'));
  await click('#advanced');await wait(()=>evaluate("page==='advanced'&&document.querySelector('#inline-frame').naturalWidth>0"));await pause(600);
  let state=await check('frame');
  if(state.platform!=='offscreen'||!state.enabled)throw new Error('Tools not integrated offscreen');
  result.checks.push('offscreen frame');await screenshot('Studio-Advanced.png');
  const menu=state.widgets.find(w=>w.type==='QMenuBar');
  if(!menu?.actions?.length)throw new Error('Native menus unavailable');
  await nativeClick(menu.actions[0].rect);await pause(250);state=await check('file menu');
  const popup=state.widgets.find(w=>w.type==='QMenu');if(!popup)throw new Error('Mouse input did not open menu');
  result.checks.push('native menu input');await screenshot('Studio-Advanced-Menu.png');
  result.fileMenu=popup.actions;
  const open=popup.actions.find(a=>a.enabled&&/打开.*(文件|图片)|Open.*File/i.test(a.text)&&!/目录|夹/.test(a.text));
  if(!open)throw new Error('Open file command unavailable');
  await nativeClick(open.rect);await pause(500);state=await check('file dialog');
  const field=state.widgets.find(w=>w.type==='QLineEdit'&&w.name==='fileNameEdit');
  if(!field)throw new Error('File dialog not rendered');
  await nativeClick(field.rect);await win.webContents.insertText('中文输入验收.png');await pause(300);state=await check('IME text');
  if(!state.widgets.some(w=>w.name==='fileNameEdit'&&w.text==='中文输入验收.png'))throw new Error('Text input did not reach Qt');
  result.checks.push('Chinese text input');await screenshot('Studio-Advanced-Dialog.png');
  await click('#inline-dismiss');await pause(300);
  state=await check('native annotation edit');
  const before=JSON.parse(fs.readFileSync(path.join(project,'annotations','qa_0.json'),'utf8')).shapes[0].points;
  const canvas=state.canvas,p=[40,40],finish=[43,42];
  const imagePoint=point=>evaluate(`(()=>{const c=${JSON.stringify(canvas)},p=${JSON.stringify(point)},r=document.querySelector('#inline-frame').getBoundingClientRect(),s=Math.min(r.width/inlineTools.width,r.height/inlineTools.height);return {x:Math.round(r.x+(r.width-inlineTools.width*s)/2+(c.pos[0]+(p[0]+c.offset[0])*c.scale)*s),y:Math.round(r.y+(r.height-inlineTools.height*s)/2+(c.pos[1]+(p[1]+c.offset[1])*c.scale)*s)};})()`);
  const a=await imagePoint(p),b=await imagePoint(finish);
  for(const [type,point] of [['mouseMove',a],['mouseDown',a],['mouseMove',b],['mouseUp',b]]){win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await pause(130);}
  result.afterDrag=(await diagnostics()).inline;
  await click('#inline-save');await click('#inline-back');await wait(()=>evaluate("page==='editor'&&!!editor.image"));
  await wait(()=>evaluate(`JSON.stringify(editor.data.shapes[0].points)!==${JSON.stringify(JSON.stringify(before))}`));
  const after=await evaluate('editor.data.shapes[0].points');
  if(JSON.stringify(before)===JSON.stringify(after))throw new Error('Native annotation edit not saved and synchronized');
  result.checks.push('native canvas drag and annotation sync');
  result.checks.push('save and return');
  await click('.nav-item[data-page=models]');await click('#smart-tools');await wait(()=>evaluate("page==='advanced'&&inlineTools.active"));await pause(500);await check('interactive models');await screenshot('Studio-Advanced-Models.png');
  await click('#inline-back');await wait(()=>evaluate("page==='editor'"));
  const qaRoot=path.join(root,'.runtime','studio-test','pose-templates-'+Date.now());
  const fill=async(selector,value)=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);await win.webContents.insertText(value);};
  const choose=async(selector,value)=>evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  for(const preset of ['dog','custom']){
   await click('#new-project');await click('[data-task=pose]');await choose('#new-preset',preset);
   const location=path.join(qaRoot,preset);await fill('#new-name','骨点界面验收 '+preset);await fill('#new-classes',preset==='dog'?'狗':'机械臂');await fill('#new-source',path.join(root,'.runtime','smoke-v2','pose','images'));await fill('#new-root',location);
   if(preset==='custom'){await fill('#new-points','底座\n关节\n末端');await fill('#new-edges','1-2, 2-3');}
   if(preset==='custom')await screenshot('Studio-NewProject-Pose.png');
   await click('#create-project');await wait(()=>evaluate(`editor.project?.root===${JSON.stringify(location)}&&!!editor.image&&page==='editor'&&!document.querySelector('#project-dialog').open`));await pause(350);
   const length=await evaluate('editor.project.template.points.length');if(length!==(preset==='dog'?24:3))throw new Error('Pose template count incorrect');
   await wait(()=>evaluate("document.querySelector('#predict-model').value===''"));
   const coords=await evaluate("(()=>{const r=editor.canvas.getBoundingClientRect();return [[18,18],[76,76]].map(p=>({x:Math.round(r.x+editor.offset[0]+p[0]*editor.zoom),y:Math.round(r.y+editor.offset[1]+p[1]*editor.zoom)}));})()");
   result.poseDrawTrace=[];
   for(const [type,point] of [['mouseMove',coords[0]],['mouseDown',coords[0]],['mouseMove',coords[1]],['mouseUp',coords[1]]]){
    win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await pause(100);
    result.poseDrawTrace.push(await evaluate(`({event:${JSON.stringify(type)},target:document.elementFromPoint(${point.x},${point.y})?.id,mode:editor.mode,drag:editor.drag,shapes:editor.data.shapes.length})`));
   }
   await wait(()=>evaluate(`editor.data.shapes.length===${length+1}`));await click('#save-annotation');await wait(()=>evaluate('!editor.dirty&&!editor.saving'));
   const label=JSON.parse(fs.readFileSync(path.join(location,'annotations','qa_0.json'),'utf8'));if(label.shapes.length!==length+1)throw new Error('Pose template placement incorrect');
   result.checks.push(preset+' pose template and save');await screenshot('Studio-Pose-'+preset+'.png');
  }
  if(process.env.XAL_QA_POSE_TRAIN==='1'){
   await click('#approve-annotation');await wait(()=>evaluate("editor.name==='qa_1.png'"));
   const coords=await evaluate("(()=>{const r=editor.canvas.getBoundingClientRect();return [[18,18],[76,76]].map(p=>({x:Math.round(r.x+editor.offset[0]+p[0]*editor.zoom),y:Math.round(r.y+editor.offset[1]+p[1]*editor.zoom)}));})()");
   await click('#tool-draw');for(const [type,point] of [['mouseDown',coords[0]],['mouseMove',coords[1]],['mouseUp',coords[1]]]){win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await pause(100);}
   await wait(()=>evaluate('editor.data.shapes.length===4'));await click('#approve-annotation');await wait(()=>evaluate("editor.name==='qa_2.png'"));
   await click('.nav-item[data-page=train]');
   const weights=path.join(root,'.runtime','pretrained','yolov8n-pose.pt');
   await evaluate(`(()=>{const s=document.querySelector('#train-model'),p=${JSON.stringify(weights)};s.add(new Option('本地姿态权重',p));s.value=p;})()`);
   await fill('#train-epochs','1');await fill('#train-batch','2');await fill('#train-imgsz','64');await evaluate("document.querySelector('#train-amp').checked=false");
   await click('#train-start');await wait(()=>evaluate("['starting','training','completed','failed'].includes(state.training_info?.status)"));
   await wait(()=>evaluate("['completed','failed'].includes(state.training_info?.status)"),180000);
   result.poseTraining=await evaluate('state.training_info');
   if(result.poseTraining.status!=='completed'||!fs.existsSync(path.join(result.poseTraining.run,'weights','best.workflow.json')))throw new Error('Custom pose training failed');
   result.checks.push('custom pose CPU training and template metadata');await screenshot('Studio-CustomPose-Training.png');
  }
  await click('.nav-item[data-page=train]');await click('#training-advanced');await pause(800);
  state=await check('training dialog');
  if(!state.widgets.some(w=>w.type==='UltralyticsDialog'||w.title?.includes('Ultralytics')))throw new Error('Advanced training dialog not rendered');
  result.checks.push('advanced training inside Electron');await screenshot('Studio-Advanced-Training.png');
  await click('#inline-dismiss');await pause(350);
  await click('#inline-back');await wait(()=>evaluate("page==='editor'"));
 }catch(error){result.errors.push(error.stack);try{await screenshot('Studio-Inline-Failure.png');result.diagnostic=await diagnostics();}catch{}}
 fs.writeFileSync(target,JSON.stringify(result,null,2));
 try{await request('prepare_exit');}catch{}
 setTimeout(()=>{if(backend()?.exitCode===null)backend().kill();app.exit(result.errors.length?1:0);},600);
};
