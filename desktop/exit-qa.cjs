module.exports=async({win,app,backend,request,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path'),kind=process.env.XAL_QA_EXITCASE;
 const result={case:kind,exited:false},target=path.join(root,'.runtime','exit-'+kind+'.json');
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const evaluate=s=>win.webContents.executeJavaScript(s,true);
 const wait=async test=>{const end=Date.now()+25000;while(Date.now()<end){if(await test())return;await pause(100);}throw new Error('Exit QA timed out');};
 const click=async selector=>{const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await pause(100);};
 try{
  await wait(()=>evaluate('!!window.editor'));win.show();win.focus();
  if(kind!=='startup')await wait(()=>Promise.resolve(ready()));
  if(kind==='dialog'){await click('#new-project-main');await wait(()=>evaluate("document.querySelector('#project-dialog').open"));result.dialogOpen=true;}
  if(kind==='advanced'){
   await click('.nav-item[data-page=train]');await click('#training-advanced');
   await wait(()=>evaluate("page==='advanced'&&document.querySelector('#inline-frame').naturalWidth>0"));
   result.advancedPanelOpen=true;
  }
  if(kind==='dirty'){
   const report=JSON.parse(fs.readFileSync(path.join(root,'.runtime','studio-check.json'),'utf8'));
   const project=report.tasks.find(t=>t.task==='detect').project;await request('open_project',{path:path.join(project,'project.json')});await pause(250);await click('.nav-item[data-page=editor]');await wait(()=>evaluate('!!editor.image'));
   const before=await evaluate('editor.data.shapes.length');
   const points=await evaluate("(()=>{const r=editor.canvas.getBoundingClientRect();return [[5,5],[13,13]].map(p=>({x:Math.round(r.x+editor.offset[0]+p[0]*editor.zoom),y:Math.round(r.y+editor.offset[1]+p[1]*editor.zoom)}));})()");
   win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...points[0]});win.webContents.sendInputEvent({type:'mouseMove',button:'left',...points[1]});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...points[1]});await wait(()=>evaluate('editor.dirty'));
   result.expectedShapes=before+1;result.annotation=path.join(project,'annotations','qa_0.json');result.unsaved=true;
  }
  fs.writeFileSync(target,JSON.stringify(result,null,2));await click('[data-window=close]');
  setTimeout(()=>{if(!win.isDestroyed()){fs.writeFileSync(target,JSON.stringify({...result,error:'Window did not exit'},null,2));backend()?.kill();app.exit(1);}},15000);
 }catch(error){fs.writeFileSync(target,JSON.stringify({...result,error:String(error)},null,2));backend()?.kill();app.exit(1);}
};
