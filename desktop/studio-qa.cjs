/* Real renderer input tests. Uses only isolated synthetic projects. */
module.exports=async function({win,app,backend,request,ready,root}){
 const fs=require('node:fs'),path=require('node:path');
 const result={version:3,tasks:[],errors:[]};
 const stage=name=>{result.stage=name;fs.writeFileSync(path.join(root,'.runtime','studio-progress.json'),JSON.stringify(result,null,2));};
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const evaluate=source=>win.webContents.executeJavaScript(source,true);
 const wait=async(test,timeout=20000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await test())return;await pause(120);}throw new Error('QA timeout');};
 const point=async selector=>evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});target.scrollIntoView({block:'nearest'});const r=target.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 const click=async selector=>{const p=await point(selector);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(p.x),y:Math.round(p.y)});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(p.x),y:Math.round(p.y)});await pause(160);};
 const fill=async(selector,value)=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);await win.webContents.insertText(String(value));};
 const select=async(selector,value)=>evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const screenshot=async name=>{await pause(250);fs.writeFileSync(path.join(root,'文档','界面预览',name),(await win.webContents.capturePage()).toPNG());};
 const uiErrors=[];
 win.webContents.on('console-message',(_event,details)=>{if(details?.level==='error')uiErrors.push(details.message);});
 try{
  await wait(()=>Promise.resolve(ready()),60000);win.show();win.focus();
  await wait(()=>evaluate('!!window.editor'));
  result.ready=true;
  await evaluate("window.workbench.theme('dark')");await pause(400);
  await screenshot('Studio-Dark.png');
  await click('#new-project-main');
  await wait(()=>evaluate("document.querySelector('#project-dialog').open"));
  result.poseHiddenForDetection=await evaluate("document.querySelector('#new-pose-fields').hidden");
  for(const task of ['segment','pose','obb','classify','detect']){
   await click(`[data-task=${task}]`);
   const visible=await evaluate("!document.querySelector('#new-pose-fields').hidden");
   if(visible!==(task==='pose'))throw new Error('Pose fields visible for wrong task');
  }
  await screenshot('Studio-NewProject-Dark.png');
  await click('#close-project-dialog');
  result.taskPicker=true;
  await evaluate("window.workbench.theme('light')");await pause(400);
  await screenshot('Studio-Light.png');
  await evaluate("window.workbench.theme('dark')");
  if(process.env.XAL_QA_EXTRA==='1')await require('./qa-extra.cjs')({win,root,request,evaluate,pause,wait,click,select,screenshot,result});
  if(process.env.XAL_QA_FULL==='1'){
   const qaRoot=path.join(root,'.runtime','studio-test',String(Date.now()));fs.mkdirSync(qaRoot,{recursive:true});
   const draw=async(points)=>{
    const coords=await evaluate(`(()=>{const r=editor.canvas.getBoundingClientRect();return ${JSON.stringify(points)}.map(p=>({x:Math.round(r.x+editor.offset[0]+p[0]*editor.zoom),y:Math.round(r.y+editor.offset[1]+p[1]*editor.zoom)}));})()`);
    const [a,b]=coords;win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...a});win.webContents.sendInputEvent({type:'mouseMove',button:'left',...b});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...b});await pause(180);
   };
   const canvasClick=async p=>{const c=await evaluate(`(()=>{const r=editor.canvas.getBoundingClientRect();return {x:Math.round(r.x+editor.offset[0]+${p[0]}*editor.zoom),y:Math.round(r.y+editor.offset[1]+${p[1]}*editor.zoom)};})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...c});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...c});await pause(80);};
   for(const task of ['detect','segment','pose','obb','classify']){
    stage('create '+task);
    await evaluate("go('data')");await click('#new-project-main');await click(`[data-task=${task}]`);
    const project=path.join(qaRoot,task);
    await fill('#new-name','合成界面验收 '+task);await fill('#new-classes','object');await fill('#new-source',path.join(root,'.runtime','smoke-v2',task,'images'));await fill('#new-root',project);
    if(task==='pose')await select('#new-preset','human');
    await click('#create-project');await wait(()=>evaluate(`!!editor.image&&editor.project?.root===${JSON.stringify(project)}`));await pause(300);
    const suffix={detect:'',segment:'-seg',pose:'-pose',obb:'-obb',classify:'-cls'}[task];
    if(await evaluate("document.querySelector('#train-model').value")!=='yolov8n'+suffix+'.pt')throw new Error('Default model does not match task '+task);
    if(task==='segment'){for(const p of [[15,15],[70,15],[75,70],[20,75]])await canvasClick(p);win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});}
    else if(task==='classify')await click('#tool-draw');
    else await draw([[18,18],[76,76]]);
    await click('#save-annotation');await wait(()=>evaluate('!editor.dirty&&!editor.saving'));
    const saved=JSON.parse(fs.readFileSync(path.join(project,'annotations','qa_0.json'),'utf8'));
    const count=task==='pose'?18:task==='classify'?0:1;
    if(saved.shapes.length!==count)throw new Error(task+' incorrect shapes '+saved.shapes.length);
    if(task==='classify'&&!saved.flags.object)throw new Error('Classification not saved');
    await screenshot('Studio-Editor-'+task+'.png');
    if(task==='detect'){
     await click('#add-class');await fill('#text-value','second');await click('#text-form button[type=submit]');await wait(()=>evaluate("document.querySelector('#active-class').value==='second'"));
     await draw([[4,4],[13,13]]);await click('#save-annotation');await wait(()=>evaluate('!editor.dirty&&!editor.saving'));
     const actual=JSON.parse(fs.readFileSync(path.join(project,'annotations','qa_0.json'),'utf8'));if(actual.shapes.at(-1).label!=='second')throw new Error('Category switch failed');
     result.categorySwitch=true;
     await click('#approve-annotation');await wait(()=>evaluate("editor.name==='qa_1.png'"));await draw([[18,18],[76,76]]);await click('#approve-annotation');await wait(()=>evaluate("editor.name==='qa_2.png'"));
     await evaluate("go('train')");await pause(250);await screenshot('Studio-Training.png');
     await fill('#train-epochs','1');await fill('#train-batch','2');await fill('#train-imgsz','64');
     await evaluate("document.querySelector('#train-amp').checked=false");
     const invalid=await evaluate("[...document.querySelector('#training-form').elements].filter(e=>e.willValidate&&!e.checkValidity()).map(e=>({id:e.id,value:e.value,message:e.validationMessage}))");
     if(invalid.length)throw new Error('Invalid default training fields '+JSON.stringify(invalid));
     await click('#train-start');await wait(()=>evaluate("['starting','training','completed','failed'].includes(state.training_info?.status)"));await wait(()=>evaluate("['completed','failed'].includes(state.training_info?.status)"),180000);
     const training=await evaluate('state.training_info');result.training=training;if(training.status!=='completed'||!fs.existsSync(path.join(training.run,'weights','best.pt')))throw new Error('Training failed: '+training.error);
     await screenshot('Studio-Training-Completed.png');
    }
    result.tasks.push({task,saved:true,shapes:saved.shapes.length,project});
   }
  }
  result.noConnectingScreen=await evaluate("!document.body.textContent.includes('正在连接原生标注工作区')");
  result.consoleErrors=uiErrors;
 }catch(error){result.errors.push(error.stack);try{await screenshot('Studio-QA-Failure.png');}catch{}}
 fs.mkdirSync(path.join(root,'.runtime'),{recursive:true});fs.writeFileSync(path.join(root,'.runtime',process.env.XAL_QA_EXTRA?'studio-extra-check.json':'studio-check.json'),JSON.stringify(result,null,2));
 if(backend()?.exitCode===null){try{await request('prepare_exit');}catch{}}
 setTimeout(()=>{if(backend()&&!backend().killed)backend().kill();app.exit(result.errors.length?1:0);},1200);
};
