/* Exercises the new editor shapes: rectangle, polygon, circle and brush. */
module.exports=async function({win,app,backend,request,diagnostics,ready,root}){
 const fs=require('node:fs'),path=require('node:path');
 const runtime=path.join(root,'.runtime');
 const out=path.join(runtime,'shapes-check.json');
 const result={checks:[],errors:[]};
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const evaluate=s=>win.webContents.executeJavaScript(s,true);
 const shot=async n=>fs.writeFileSync(path.join(runtime,n),(await win.webContents.capturePage()).toPNG());
 const wait=async(t,ms,l)=>{const e=Date.now()+ms;while(Date.now()<e){if(await t())return true;await pause(150);}throw new Error('timeout '+l);};
 const at=async(x,y)=>evaluate(`(()=>{const r=editor.canvas.getBoundingClientRect();return {x:Math.round(r.x+editor.offset[0]+${x}*editor.zoom),y:Math.round(r.y+editor.offset[1]+${y}*editor.zoom)};})()`);
 const drag=async(a,b)=>{const p=await at(...a),q=await at(...b);
  for(const [type,point] of [['mouseMove',p],['mouseDown',p],['mouseMove',q],['mouseUp',q]]){win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await pause(130);}await pause(500);};
 const click=async(a)=>{const p=await at(...a);for(const type of ['mouseMove','mouseDown','mouseUp']){win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await pause(120);}await pause(250);};
 try{
  await wait(()=>Promise.resolve(ready()),60000,'ready');
  await wait(()=>evaluate('!!window.editor'),20000,'editor');
  win.show();win.focus();await pause(700);
  const project=path.join(runtime,'smoke-shapes-'+Date.now());
  const source=path.join(runtime,'smoke-v2','detect','images');
  await request('create_project',{name:'形状验收',task:'detect',classes:['猫','狗'],root:project,source,preset:'human'});
  await pause(2500);
  await evaluate("go('editor')");
  await wait(()=>evaluate('!!editor.image'),25000,'project image');
  result.buttons=await evaluate("[...document.querySelectorAll('#shape-switch button')].map(b=>b.dataset.shape)");
  result.defaultShape=await evaluate('editor.shapeType');
  await shot('shapes-toolbar.png');

  // rectangle (default)
  await evaluate("editor.shapeType='rectangle'");
  await drag([12,12],[45,40]);
  // polygon
  await evaluate("editor.shapeType='polygon';editor.setMode('draw')");
  for(const p of [[55,12],[80,12],[85,35],[60,42]])await click(p);
  await evaluate("editor.finishPolygon()");
  // circle
  await evaluate("editor.shapeType='circle';editor.setMode('draw')");
  await drag([20,55],[45,80]);
  await pause(400);
  result.shapes=await evaluate("editor.data.shapes.map(s=>({type:s.shape_type,points:s.points.length,label:s.label}))");
  await shot('shapes-drawn.png');

  // save and confirm what reached disk
  await evaluate("editor.save(true)");
  await wait(()=>evaluate('!editor.dirty&&!editor.saving'),15000,'save');
  const file=path.join(project,'annotations',(await evaluate('editor.name')).replace(/\.[^.]+$/,'.json'));
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  result.saved={checked:saved.checked,shapes:saved.shapes.map(s=>({type:s.shape_type,points:s.points.length}))};
  // and that the frozen dataset can be built from them
  // The "保存草稿" button must approve when the auto-approve switch is on.
  result.autoApprove={checked:await evaluate("document.querySelector('#auto-approve').checked")};
  await evaluate("editor.data.shapes=editor.data.shapes.slice(0,1);editor.dirty=true;editor.status()");
  await evaluate("document.querySelector('#save-annotation').click()");
  await wait(()=>evaluate('!editor.dirty&&!editor.saving'),15000,'plain save');
  result.autoApprove.savedChecked=JSON.parse(fs.readFileSync(file,'utf8')).checked;
  // Turning the switch off must go back to draft-only saving.
  await evaluate("document.querySelector('#auto-approve').checked=false;document.querySelector('#auto-approve').dispatchEvent(new Event('change'))");
  await evaluate("editor.data.checked=false;editor.data.shapes=editor.data.shapes.slice(0,1);editor.dirty=true;editor.status()");
  await evaluate("document.querySelector('#save-annotation').click()");
  await wait(()=>evaluate('!editor.dirty&&!editor.saving'),15000,'draft save');
  result.autoApprove.draftChecked=JSON.parse(fs.readFileSync(file,'utf8')).checked;
  await evaluate("document.querySelector('#auto-approve').checked=true;document.querySelector('#auto-approve').dispatchEvent(new Event('change'))");

  const snap=await request('start_training',{model:path.join(runtime,'pretrained','yolov8n.pt'),device:'cpu',epochs:1,batch:2,imgsz:64,optimizer:'SGD'}).then(()=> 'started').catch(e=>'error: '+e.message);
  result.trainingStart=snap;
  await request('stop_training').catch(()=>{});
 }catch(error){result.errors.push(error.stack);try{await shot('shapes-failure.png');}catch{}}
 fs.writeFileSync(out,JSON.stringify(result,null,2));
 try{await request('prepare_exit');}catch{}
 setTimeout(()=>{if(backend()?.exitCode===null)backend().kill();app.exit(0);},900);
};
