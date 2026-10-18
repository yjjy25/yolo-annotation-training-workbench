/* Inspector layout, current landmark, keyboard cycling and persisted preferences. */
module.exports=async({win,app,backend,request,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const folder=process.env.XAL_QA_INSPECTOR_ROOT,report={checks:[],errors:[]};
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async fn=>{const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await pause(80);}throw new Error('UI timeout');};
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
 const click=async selector=>{const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await pause(100);};
 const key=async(keyCode,modifiers=[])=>{for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode,modifiers});await pause(100);};
 const drag=async(a,b)=>{const coords=await ev(`(()=>{const r=editor.canvas.getBoundingClientRect();return ${JSON.stringify([a,b])}.map(p=>({x:Math.round(r.x+editor.offset[0]+p[0]*editor.zoom),y:Math.round(r.y+editor.offset[1]+p[1]*editor.zoom)}));})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...coords[0]});win.webContents.sendInputEvent({type:'mouseMove',button:'left',...coords[1]});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...coords[1]});await pause(100);};
 const screenshot=async name=>{await ev("document.querySelector('.inspector').scrollTop=0");await pause(300);fs.writeFileSync(path.join(folder,name),(await win.webContents.capturePage()).toPNG());};
 const source=path.join(root,'.runtime','dog-pose-photo-candidates'),project=path.join(folder,'six-labels');
 const commonFit=()=>ev(`(()=>{const host=document.querySelector('.inspector').getBoundingClientRect();return ['#pose-point-name','#pose-point-count','#pose-current-reference','#occluded','#skip-point'].every(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.top>=host.top&&r.bottom<=host.bottom&&r.left>=host.left&&r.right<=host.right;})&&document.documentElement.scrollWidth<=innerWidth;})()`);
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.showVideoImport'));win.show();win.focus();await ev("window.workbench.theme('dark')");await pause(200);
  await request('create_project',{root:project,name:'姿态侧栏验收',task:'pose',classes:['坐','跑','跳','走','卧','站'],preset:'dog',source});
  await ev('api.state().then(update)');await ev("go('editor')");await wait(()=>ev('!!editor.image'));
  check('six labels displayed as a regular three-column grid',await ev("getComputedStyle(document.querySelector('#class-shortcuts')).gridTemplateColumns.split(' ').length===3&&document.querySelector('#class-shortcuts').children.length===6&&document.querySelector('#active-class').hidden"));
  check('advanced template controls collapsed by default',await ev("!document.querySelector('#pose-options').open"));
  await ev("document.querySelector('#pose-placement').focus()");await key('Down');await key('Return');
  check('placement changed using keyboard',await ev("document.querySelector('#pose-placement').value==='sequence'"));
  await click('#pose-options summary');await click('#template-mirror');await click('#template-flip');await click('#pose-options summary');
  await click('#tool-draw');await drag([30,20],[350,310]);await drag([75,60],[75,60]);await drag([60,50],[60,50]);
  check('current point is prominent and identifies next exact landmark',await ev("editor.pose.index===2&&document.querySelector('#pose-point-name').textContent==='左前肘'&&document.querySelector('#pose-point-count').textContent==='3 / 24'&&parseFloat(getComputedStyle(document.querySelector('#pose-point-name')).fontSize)>=22"));
  const move=async p=>{const at=await ev(`(()=>{const r=editor.canvas.getBoundingClientRect();return {x:Math.round(r.x+editor.offset[0]+${p[0]}*editor.zoom),y:Math.round(r.y+editor.offset[1]+${p[1]}*editor.zoom)};})()`);win.webContents.sendInputEvent({type:'mouseMove',...at});await pause(100);};
  await move([75,60]);check('hovering an existing point shows its name',await ev("$('#pose-point-name').textContent==='左前爪'&&$('#pose-phase').textContent==='正在微调'"));
  await move([180,170]);check('moving away restores current next landmark and skip action',await ev("$('#pose-point-name').textContent==='左前肘'&&$('#pose-phase').textContent==='下一骨点'&&$('#skip-point-label').textContent==='跳过此点'&&editor.pose.index===2"));
  await drag([75,60],[85,65]);check('dragging an old point keeps adjustment context',await ev("$('#pose-point-name').textContent==='左前爪'&&editor.pose.index===2"));
  await move([180,170]);check('moving away after dragging restores the pending task',await ev("$('#pose-point-name').textContent==='左前肘'&&editor.selected===-1"));
  await move([85,65]);await click('#pose-phase');check('leaving canvas for sidebar restores current task',await ev("$('#pose-point-name').textContent==='左前肘'&&$('#pose-phase').textContent==='下一骨点'"));
  check('hover does not place extra points or advance the sequence',await ev('editor.data.shapes.length===3&&editor.pose.index===2'));
  const before=await ev('JSON.stringify(editor.data)'),group=await ev('editor.pose.group');
  await key('Tab');check('Tab changes current label without interrupting skeleton',await ev(`editor.activeClass==='跑'&&editor.pose.index===2&&editor.pose.group===${group}&&JSON.stringify(editor.data)===${JSON.stringify(before)}&&editor.mode==='draw'`));
  await key('Tab',['shift']);check('Shift Tab cycles back',await ev("editor.activeClass==='坐'&&editor.pose.index===2"));
  await key('o');check('occlusion shortcut still changes next point state',await ev("editor.nextOccluded&&document.querySelector('#occluded').checked"));
  check('common controls fit without scrolling in normal window',await commonFit());await screenshot('sidebar-dark.png');
  await click('#pose-current-reference');await wait(()=>ev("document.querySelector('#pose-photo').dataset.ready==='true'&&document.querySelector('#pose-photo').dataset.highlightPresent==='true'"));
  check('one click opens current elbow on reference photo',await ev("document.querySelector('#pose-point-legend button:nth-child(3)').classList.contains('selected')&&document.querySelector('#pose-photo-point-status').textContent.includes('左前肘')"));
  await click('#pose-guide-close');
  await click('#skip-point');check('skip advances prominent point',await ev("editor.pose.index===3&&document.querySelector('#pose-point-name').textContent==='左后爪'"));
  await key('k');check('keyboard skip works after clicking skip button',await ev('editor.pose.index===4'));
  await ev('editor.canvas.focus()');await key('d');await wait(()=>ev('!!editor.image&&!editor.pose'));
  check('next image keeps sequence placement, mirror orientation and draw mode',await ev("document.querySelector('#pose-placement').value==='sequence'&&document.querySelector('#template-mirror').checked&&document.querySelector('#template-flip').checked&&editor.mode==='draw'"));
  // Finish a template instance, then confirm temporary adjustment mode does not persist.
  await ev("document.querySelector('#pose-placement').focus()");await key('Up');await key('Return');await drag([30,20],[350,310]);
  check('template placement still enters temporary selection for fine tuning',await ev("editor.data.shapes.length===25&&editor.mode==='select'&&editor.preferences.mode==='draw'"));
  await ev('editor.canvas.focus()');await key('d');await wait(()=>ev("editor.mode==='draw'"));
  check('next image automatically returns to drawing',await ev("editor.mode==='draw'&&document.querySelector('#pose-placement').value==='template'"));
  // Restore sequence, change a label, then reload renderer to test durable settings.
  await ev("document.querySelector('#pose-placement').focus()");await key('Down');await key('Return');await ev('editor.canvas.focus()');await key('Tab');
  win.webContents.reload();await wait(()=>ev(`!!window.editor&&editor.project?.root===${JSON.stringify(project)}`));await ev("go('editor')");await wait(()=>ev('!!editor.image'));
  check('renderer restart restores label, placement and mirror settings',await ev("editor.activeClass==='跑'&&document.querySelector('#pose-placement').value==='sequence'&&editor.mirrorX&&editor.mirrorY&&editor.mode==='draw'"));
  await ev('editor.canvas.focus()');await key('End');await wait(()=>ev('editor.data.shapes.length===0'));
  await drag([30,20],[350,310]);await drag([75,60],[75,60]);await drag([60,50],[60,50]);
  check('new image starts sequence without reselecting placement or draw tool',await ev('editor.pose?.index===2'));
  await ev("window.workbench.theme('light')");await pause(200);check('common controls fit in light theme',await commonFit());await screenshot('sidebar-light.png');
  win.setSize(1050,700);await pause(300);await ev("document.querySelector('.inspector').scrollTop=0");
  check('common controls fit at minimum 1050x700 window',await commonFit());await screenshot('sidebar-small.png');
  // Exact cat/dog cycling example, in a separate project with no shared preferences.
  await key('Escape');await ev('editor.save()');
  await request('create_project',{root:path.join(folder,'cat-dog'),name:'猫狗标签验收',task:'detect',classes:['猫','狗'],source});
  await ev('api.state().then(update)');await ev("go('editor')");await wait(()=>ev('!!editor.image'));await ev('editor.canvas.focus()');
  check('new project has independent default settings',await ev("editor.activeClass==='猫'&&!editor.mirrorX&&!editor.mirrorY"));
  await key('Tab');check('cat becomes dog after one Tab',await ev("editor.activeClass==='狗'"));await key('Tab');check('dog cycles back to cat',await ev("editor.activeClass==='猫'"));await key('Tab',['shift']);check('Shift Tab supports reverse cat dog cycling',await ev("editor.activeClass==='狗'"));
 }catch(error){report.errors.push(error.stack);try{await screenshot('failure.png');}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
