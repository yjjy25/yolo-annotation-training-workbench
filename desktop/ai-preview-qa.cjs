module.exports=async({win,app,backend,request,ready})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
 const folder=process.env.XAL_QA_AIPREVIEW_ROOT,report={checks:[],errors:[]};
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);};
 const wait=async fn=>{const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await pause(100);}throw new Error('UI timeout');};
 const shot=async name=>{await pause(200);fs.writeFileSync(path.join(folder,name),(await win.webContents.capturePage()).toPNG());};
 const click=async selector=>{const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await pause(100);};
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.aiPreview'));win.show();win.focus();
  const root=path.join(folder,'项目'),source=path.join(folder,'来源');
  await request('create_project',{root,name:'AI候选与跨视频验收',task:'detect',classes:['object','other'],source});await ev('api.state().then(update)');
  const names=fs.readdirSync(path.join(root,'images')).sort();
  const proposal=()=>({model:'controlled-test-fixture.pt',base_hash:null,task:'detect',classes:['object','other'],template:null,annotation:{imageWidth:160,imageHeight:120,imagePath:'../images/'+names[0],flags:{},checked:false,shapes:[{label:'object',shape_type:'rectangle',points:[[20,20],[90,20],[90,80],[20,80]],flags:{},group_id:null}]}});
  const latest=path.join(root,'proposals','latest');fs.mkdirSync(latest,{recursive:true});
  for(const name of names.slice(0,2))fs.writeFileSync(path.join(latest,path.parse(name).name+'.json'),JSON.stringify(proposal()));
  // Two extracted-video manifests, with the boundary on the gallery page edge.
  for(const [id,frames] of [['video-a',names.slice(0,24)],['video-b',names.slice(24)]]){
   const dir=path.join(root,'videos',id);fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({id,status:'completed',source_name:id+'.mp4',frames:frames.map((name,i)=>({name,frame:i*10,seconds:i}))}));
  }
  await ev('window.refreshVideoSequences()');await ev('loadImages()');
  check('dataset exposes AI candidate counts',await ev("items.filter(i=>i.aiCount===1).length===2&&$('#gallery').querySelectorAll('.tile-ai-preview').length===2"));
  await click('#dataset-ai-overlay');await wait(()=>ev("$('#gallery .tile-ai-overlay')?.width>1"));
  check('thumbnail AI overlay renders without accepting annotations',!fs.existsSync(path.join(root,'annotations',path.parse(names[0]).name+'.json')));
  await shot('dataset-ai-preview.png');await click('#gallery .tile-ai-preview');
  await wait(()=>ev("!$('#ai-preview-edit').disabled"));check('large preview shows actual candidate count',await ev("$('#ai-preview-info').textContent.startsWith('1 个 AI 候选')"));await shot('large-ai-preview.png');
  await click('#ai-preview-open');await wait(()=>ev("page==='editor'&&!!editor.proposal"));
  await ev("window.__shortcutEvents=[];document.addEventListener('keydown',e=>window.__shortcutEvents.push({key:e.key,alt:e.altKey,ctrl:e.ctrlKey,defaultPrevented:e.defaultPrevented}),true);editor.canvas.focus();void 0");
  await ev("const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(document.body);selection.removeAllRanges();selection.addRange(range);void 0");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'E'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'E'});
  await wait(()=>ev('editor.data?.shapes.length===1&&!editor.proposal&&!editor.accepting'));
  report.shortcutEvents=await ev('window.__shortcutEvents');
  check('native E accepts a candidate and clears existing webpage selection',await ev("String(window.getSelection()).length===0"));
  check('preview acceptance loads solid editable shapes in the same image',await ev(`editor.name===${JSON.stringify(names[0])}&&editor.mode==='select'&&$('#shape-count').textContent==='1'`));
  check('canvas exposes one Save action with automatic review',await ev("$('#approve-annotation').hidden&&$('#save-annotation').textContent==='保存，下一张 →'"));
  check('candidate counter and proposal clear after acceptance',await ev("$('#candidate-count').textContent==='0'&&$('#accept-candidate').disabled"));
  await ev("editor.canvas.focus();editor.chooseClass('object');void 0");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Q'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Q'});await pause(100);
  check('native Q switches to the next label',await ev("editor.activeClass==='other'"));
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Q',modifiers:['shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Q',modifiers:['shift']});await pause(100);
  check('native Shift+Q switches to the previous label',await ev("editor.activeClass==='object'"));
  const shortcutName=await ev('editor.name');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'E'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'E'});await pause(100);
  check('E without a candidate never navigates or selects page text',await ev(`editor.name===${JSON.stringify(shortcutName)}&&String(window.getSelection()).length===0`));
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});await pause(100);
  check('Ctrl+A does not accidentally navigate to the previous frame',await ev(`editor.name===${JSON.stringify(shortcutName)}`));
  await ev('window.getSelection().removeAllRanges();void 0');

  const before=await ev('structuredClone(editor.data.shapes[0].points)');
  const coords=await ev("(()=>{const r=editor.canvas.getBoundingClientRect();return [[55,50],[65,60]].map(p=>({x:Math.round(r.x+editor.offset[0]+p[0]*editor.zoom),y:Math.round(r.y+editor.offset[1]+p[1]*editor.zoom)}));})()");
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...coords[0]});win.webContents.sendInputEvent({type:'mouseMove',button:'left',...coords[1]});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...coords[1]});await pause(100);
  check('accepted candidate responds to a real mouse drag',await ev(`editor.dirty&&JSON.stringify(editor.data.shapes[0].points)!==${JSON.stringify(JSON.stringify(before))}`));
  await ev('editor.confirmSave()');check('tweaked candidate saves as reviewed annotation',await ev('editor.data.checked&&!editor.dirty'));
  const label=await request('load_annotation',{name:names[0]});check('persisted geometry contains the manual tweak',label.annotation.checked===true&&JSON.stringify(label.annotation.shapes[0].points)!==JSON.stringify(before));
  const repeated=await request('accept',{name:names[0]});check('repeated backend acceptance preserves manual changes',repeated.base_hash===label.base_hash);
  await shot('accepted-and-adjusted.png');
  await ev(`openImage(${JSON.stringify(names[1])})`);await ev('window.__negativePrompts=0;window.confirm=()=>{window.__negativePrompts++;return false;};void 0');
  check('unaccepted suggestion cannot save as a negative sample',await ev('editor.confirmSave().then(ok=>!ok&&window.__negativePrompts===0)'));
  await ev('Promise.all(Array.from({length:10},()=>editor.accept()))');check('repeated accept clicks leave a usable editable draft',await ev('editor.data.shapes.length===1&&!editor.proposal'));
  await ev(`openImage(${JSON.stringify(names[2])})`);await ev(`openImage(${JSON.stringify(names[0])})`);check('reopening retains audited manual geometry',await ev('editor.data.checked&&editor.data.shapes.length===1&&!editor.proposal'));
  // Reset the dataset filter so stepping should cross source-video boundaries.
  await ev("go('data')");await ev("$('#image-filter').value='all';$('#image-search').value='';paging.page=0;loadImages()");await ev(`openImage(${JSON.stringify(names[23])})`);await ev('navigate(1)');
  check('next crosses from video A into video B on the next gallery page',await ev(`editor.name===${JSON.stringify(names[24])}&&paging.page===1`));
  await ev('navigate(-1)');check('previous crosses back into video A',await ev(`editor.name===${JSON.stringify(names[23])}&&paging.page===0`));
  await ev('editor.data.shapes=structuredClone('+JSON.stringify(proposal().annotation.shapes)+');editor.changed();editor.approve()');
  check('save-and-next crosses video boundary instead of looping within one video',await ev(`editor.name===${JSON.stringify(names[24])}`));
  // Missing-file handling is explicit and leaves the current picture usable.
  const missing=names[25];await ev(`openImage(${JSON.stringify(missing)})`);await ev(`editor.proposal=${JSON.stringify(proposal())};void 0`);
  await ev('editor.accept()');check('missing proposal reports a clear regeneration message',await ev("$('#toast').textContent.includes('重新生成候选')&&!!editor.image"));
  await ev('editor.proposal=null;editor.data.shapes=[];editor.dirty=true;window.__negativePrompts=0;void 0');
  check('saving a target-free image reviews immediately without confirmation',await ev('editor.confirmSave().then(ok=>ok&&editor.data.checked&&window.__negativePrompts===0)'));

  await ev("go('data')");await ev("$('#image-filter').value='ai';paging.page=0;loadImages()");check('AI filter drops already accepted proposals',await ev('paging.total===0'));
 }catch(error){report.errors.push(error.stack);try{await shot('failure.png');}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
