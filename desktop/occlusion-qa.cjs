/* Actual renderer input for cross-task occlusion, isolated from user projects. */
module.exports=async({win,app,backend,request,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const folder=process.env.XAL_QA_OCCLUSION_ROOT,report={checks:[],errors:[]};
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
 const wait=async fn=>{const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await pause(100);}throw new Error('Timeout');};
 const click=async selector=>{const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await pause(150);};
 const key=async keyCode=>{for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode});await pause(100);};
 const drag=async(a,b)=>{const points=await ev(`(()=>{const r=editor.canvas.getBoundingClientRect();return ${JSON.stringify([a,b])}.map(p=>({x:Math.round(r.x+editor.offset[0]+p[0]*editor.zoom),y:Math.round(r.y+editor.offset[1]+p[1]*editor.zoom)}));})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...points[0]});win.webContents.sendInputEvent({type:'mouseMove',button:'left',...points[1]});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...points[1]});await pause(100);};
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.editor'));win.show();win.focus();
  for(const task of ['detect','segment','obb','pose','classify']){
   const projectRoot=path.join(folder,task);
   await request('create_project',{root:projectRoot,name:'遮挡验收 '+task,task,classes:['object'],preset:'human',source:path.join(root,'.runtime','video-pose-qa-accepted-20261018','project','images')});
   await ev('api.state().then(update)');await ev("go('editor')");await wait(()=>ev('!!editor.image'));
   if(task==='segment'){
    await drag([15,15],[15,15]);await drag([130,15],[130,15]);await drag([130,100],[130,100]);await drag([15,100],[15,100]);await click('#finish-polygon');
   }else if(task==='classify')await click('#tool-draw');
   else await drag([15,15],[130,100]);
   if(task!=='classify')await click('#shape-list button');
   check(task+' occlusion option enabled',await ev("!document.querySelector('#object-occlusion-controls').hidden&&!document.querySelector('#object-occluded').disabled"));
   const before=await ev('JSON.stringify(editor.data.shapes.map(s=>s.points))');
   await click('#object-occluded');
   check(task+' checkbox applies marker',await ev(task==='classify'?'editor.data.occluded===true':'editor.data.shapes[0].flags.occluded===true'));
   check(task+' geometry preserved',await ev('JSON.stringify(editor.data.shapes.map(s=>s.points))')===before);
   await key('o');check(task+' O clears marker while checkbox focused',await ev(task==='classify'?'editor.data.occluded===false':'editor.data.shapes[0].flags.occluded===false'));
   await key('o');await click('#save-annotation');await wait(()=>ev('!editor.dirty&&!editor.saving'));
   const name=await ev('editor.name');await ev('editor.open(editor.name)');if(task!=='classify')await click('#shape-list button');
   check(task+' marker survives save and reopen',await ev("document.querySelector('#object-occluded').checked"));
   const saved=JSON.parse(fs.readFileSync(path.join(projectRoot,'annotations',path.parse(name).name+'.json'),'utf8'));
   check(task+' marker written to actual JSON',task==='classify'?saved.occluded===true:saved.shapes[0].flags.occluded===true);
   if(task==='pose')check('pose box marker does not change keypoint visibility',saved.shapes.filter(s=>s.shape_type==='point').every(s=>s.difficult===false));
   if(task==='classify')check('class flags contain only class labels',Object.keys(saved.flags).length===1&&saved.flags.object===true);
   await click('#object-occluded');await click('#undo');check(task+' undo restores occlusion',await ev(task==='classify'?'editor.data.occluded===true':'editor.data.shapes[0].flags.occluded===true'));
   await pause(250);fs.writeFileSync(path.join(folder,task+'.png'),(await win.webContents.capturePage()).toPNG());
  }
 }catch(error){report.errors.push(error.stack);fs.writeFileSync(path.join(folder,'failure.png'),(await win.webContents.capturePage()).toPNG());}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
