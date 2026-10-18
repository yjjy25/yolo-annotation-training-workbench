/* Native Electron mouse/keyboard checks, using an isolated synthetic video. */
module.exports=async({win,app,backend,request,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const folder=process.env.XAL_QA_VIDEOPOSE_ROOT,report={checks:[],errors:[]};
 const evaluate=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
 const wait=async(fn,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(100);}throw new Error('QA timeout');};
 const click=async selector=>{const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await pause(100);};
 const key=async(keyCode,modifiers=[])=>{for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode,modifiers});await pause(50);};
 const fill=async(selector,value)=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);await win.webContents.insertText(String(value));};
 const select=async(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const drag=async(from,to)=>{
  const coords=await evaluate(`(()=>{const r=editor.canvas.getBoundingClientRect();return ${JSON.stringify([from,to])}.map(p=>({x:Math.round(r.x+editor.offset[0]+p[0]*editor.zoom),y:Math.round(r.y+editor.offset[1]+p[1]*editor.zoom)}));})()`);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...coords[0]});
  win.webContents.sendInputEvent({type:'mouseMove',button:'left',...coords[1]});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...coords[1]});await pause(100);
 };
 const canvasClick=p=>drag(p,p);
 const screenshot=async name=>{await pause(350);fs.writeFileSync(path.join(folder,name),(await win.webContents.capturePage()).toPNG());};
 win.webContents.on('console-message',(_event,details)=>{if(details?.level==='error')report.errors.push(details.message);});
 try{
  await wait(()=>Promise.resolve(ready()),60000);await wait(()=>evaluate('!!window.showVideoImport'));win.show();win.focus();
  report.initial=await evaluate('({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight})');
  await click('#new-project-main');await click('[data-task="pose"]');
  await fill('#new-name','合成视频姿态验收');await fill('#new-classes','person');
  await fill('#new-root',path.join(folder,'project'));
  await click('#create-project');await wait(()=>evaluate("!document.querySelector('#project-dialog').open&&state.project?.task==='pose'"));await evaluate(`window.showVideoImport(${JSON.stringify(path.join(folder,'synthetic.avi'))})`);
  check('create pose project directly from video',true);
  await fill('#video-step','0.5');await fill('#video-limit','6');await click('#video-submit');
  await wait(()=>evaluate('!!editor.image&&!!editor.name'),45000);
  check('background import yielded 6 editable frames',await evaluate('state.project.counts.total===6'));
  check('video timeline visible',await evaluate("!document.querySelector('#video-timeline').hidden"));
  await select('#pose-placement','sequence');await click('#tool-draw');await drag([12,12],[140,110]);
  check('sequential pose starts at first point',await evaluate('editor.pose?.index===0'));
  await click('#occluded');await canvasClick([70,30]);
  check('next point checkbox applies occlusion',await evaluate("editor.data.shapes[1].difficult===true&&editor.pose.index===1&&!document.querySelector('#occluded').checked"));
  await click('#save-annotation');await wait(()=>evaluate('!editor.dirty&&!editor.saving'));
  check('unfinished sequence saves as draft despite auto-approve toggle',await evaluate('editor.data.checked===false&&editor.pose.index===1'));
  await drag([70,30],[78,35]);
  check('drag during placement moves existing point without adding one',await evaluate('editor.data.shapes.length===2&&editor.pose.index===1&&Math.abs(editor.data.shapes[1].points[0][0]-78)<1'));
  await key('o');check('O edits selected point occlusion',await evaluate('editor.data.shapes[1].difficult===false'));
  // Clicking a blank canvas position resumes sequence with its own default state.
  await canvasClick([55,22]);check('next point visibility does not inherit selected point',await evaluate('editor.data.shapes[2].difficult===false&&editor.pose.index===2'));
  await key('k');check('K skips next point',await evaluate('editor.pose.index===3&&editor.data.shapes.length===3'));
  await key('z',['control']);check('undo restores skip index',await evaluate('editor.pose.index===2'));
  await key('z',['control','shift']);check('redo restores skipped index',await evaluate('editor.pose.index===3'));
  for(let i=3;i<17;i++)await key('k');
  check('all remaining points can be unknown',await evaluate('editor.pose===null&&editor.data.shapes.length===3'));
  await canvasClick([78,35]);await key('o');
  check('canvas selection synchronizes checkbox',await evaluate("editor.data.shapes[1].difficult===true&&document.querySelector('#occluded').checked"));
  const original=await evaluate('JSON.stringify(editor.data.shapes.map(s=>s.points))');await key('h');
  check('H mirrors selected pose',await evaluate('Math.abs(editor.data.shapes[1].points[0][0]-74)<1'));
  await key('h');check('double mirror restores positions',await evaluate(`editor.data.shapes.every((s,i)=>s.points.every((p,j)=>p.every((v,k)=>Math.abs(v-${original}[i][j][k])<1e-6)))`));
  await key('h',['shift']);await key('h',['shift']);check('vertical flip is reversible',await evaluate(`editor.data.shapes.every((s,i)=>s.points.every((p,j)=>p.every((v,k)=>Math.abs(v-${original}[i][j][k])<1e-6)))`));
  await screenshot('pose-editor.png');
  await click('#save-annotation');await wait(()=>evaluate('!editor.dirty&&!editor.saving'));
  const name=await evaluate('editor.name'),saved=JSON.parse(fs.readFileSync(path.join(folder,'project','annotations',path.parse(name).name+'.json'),'utf8'));
  check('saved keypoint occlusion and omissions round-trip',saved.shapes.length===3&&saved.shapes[1].difficult===true);
  await click('#pose-guide-open');await wait(()=>evaluate("!!document.querySelector('#pose-photo-note').textContent"));
  check('builtin reference photograph and 17 point legend',await evaluate("document.querySelector('#pose-point-legend').children.length===17&&document.querySelector('#pose-photo-note').textContent.includes('X-AnyLabeling')"));
  await wait(()=>evaluate("document.querySelector('#pose-photo').dataset.ready==='true'"));await click('#pose-point-legend button');
  check('point legend highlights the point and explains anatomical placement',await evaluate("document.querySelector('#pose-point-legend button').classList.contains('selected')&&document.querySelector('#pose-landmark-detail').textContent.includes('鼻尖中央')"));
  await evaluate("document.querySelector('#pose-guide-dialog').scrollTop=0");await screenshot('pose-guide.png');await evaluate("document.querySelector('#pose-standard').scrollIntoView({block:'start'})");await screenshot('pose-standard.png');
  await click('#pose-example-set');await wait(()=>Promise.resolve(fs.existsSync(path.join(folder,'project','references','pose-example.json'))));
  await click('#pose-guide-close');await click('#pose-guide-open');
  check('project photo reference persists',await evaluate("document.querySelector('#pose-photo-source').textContent===editor.name"));
  await click('#pose-guide-close');
  await click('#video-next');check('timeline switches frame after saving',await evaluate(`editor.name!==${JSON.stringify(name)}`));
  await click('#video-prev');await wait(()=>evaluate(`editor.name===${JSON.stringify(name)}`));
  check('reopened video annotation retained',await evaluate('editor.data.shapes.length===3&&editor.data.shapes[1].difficult===true'));
  await key('d');check('D advances in video sequence',await evaluate(`editor.name!==${JSON.stringify(name)}`));
  await screenshot('video-timeline.png');
  // Template placement applies both orientation controls.
  await select('#pose-placement','template');await click('#pose-options summary');await click('#template-mirror');await click('#template-flip');await click('#tool-draw');await drag([12,12],[140,110]);
  check('template orientation applies both axes',await evaluate('editor.data.shapes.length===18&&Math.abs(editor.data.shapes[1].points[0][1]-(12+.88*98))<1'));
  await canvasClick([76,98]);await key('k');check('K removes one selected template point without deleting instance',await evaluate('editor.data.shapes.length===17&&editor.data.shapes[0].shape_type==="rectangle"'));
  await key('z',['control']);check('removed template point can undo',await evaluate('editor.data.shapes.length===18'));
  // A bad codec fails visibly and creates no extra frames.
  await evaluate("go('data')");await evaluate('window.showVideoImport()');await fill('#video-path',path.join(folder,'broken.mp4'));await click('#video-submit');
  await wait(()=>evaluate("document.querySelector('#video-status').textContent.includes('无法解码')"));
  check('invalid video reports decoder error',true);await click('#video-close');
  // Inspect dog and custom guides with their actual templates, never a human overlay.
  for(const preset of ['dog','custom']){
   await request('create_project',{root:path.join(folder,preset),name:'参考验收 '+preset,task:'pose',classes:['object'],preset,template:{points:['base','joint','tip'],edges:[[0,1],[1,2]],pairs:[[0,2]]},source_kind:'video',source:path.join(folder,'synthetic.avi')});
   await evaluate('api.state().then(update)');await evaluate("go('editor')");await click('#pose-guide-open');
   await wait(()=>evaluate("document.querySelector('#pose-photo').dataset.ready==='true'"));
   check(preset+' guide uses actual keypoint count',await evaluate("document.querySelector('#pose-point-legend').children.length")===(preset==='dog'?24:3));
   await screenshot('guide-'+preset+'.png');await click('#pose-guide-close');
  }
  await evaluate("window.workbench.theme('dark')");await pause(300);await click('#pose-guide-open');await screenshot('guide-dark.png');await click('#pose-guide-close');
  check('no horizontal overflow',await evaluate('document.documentElement.scrollWidth<=innerWidth'));
 }catch(error){report.errors.push(error.stack);try{await screenshot('failure.png');}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}
 if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
