/* Native save-and-next acceptance, including filtered queues and the final frame. */
module.exports=async({win,app,backend,request,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{nativeImage}=require('electron');
 const folder=process.env.XAL_QA_SAVEADVANCE_ROOT,report={checks:[],errors:[]};
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
 const wait=async(fn)=>{const end=Date.now()+35000;while(Date.now()<end){if(await fn())return;await pause(60);}throw new Error('UI timeout');};
 const click=async selector=>{const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await pause(80);};
 const key=keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});};
 const screenshot=async name=>{fs.writeFileSync(path.join(folder,name),(await win.webContents.capturePage()).toPNG());};
 win.webContents.on('console-message',(_event,d)=>{if(d?.level==='error')report.errors.push(d.message);});
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.videoTracking'));win.show();win.focus();
  const project=path.join(folder,'project'),source=path.join(folder,'source');fs.mkdirSync(source);
  await request('create_project',{root:project,name:'保存自动下一张',task:'detect',classes:['object']});
  const bytes=nativeImage.createFromPath(path.join(root,'desktop','icon.png')).resize({width:128,height:128}).toPNG();
  const annotation={imageWidth:128,imageHeight:128,shapes:[{label:'object',shape_type:'rectangle',points:[[30,40],[100,40],[100,100],[30,100]],flags:{}}],flags:{}};
  const paths=[];
  for(let i=0;i<30;i++){const name='img_'+String(i).padStart(2,'0');const file=path.join(source,name+'.png');fs.writeFileSync(file,bytes);fs.writeFileSync(path.join(source,name+'.json'),JSON.stringify(annotation));paths.push(file);}
  await request('import_images',{paths});await ev('api.state().then(update)');await ev("$('#image-filter').value='all';paging.page=0;loadImages()");await ev("openImage('img_00.png')");
  await ev("window.__baseEditorRPC=editor.callbacks.rpc;window.__baseRPC=rpc;window.__writeCount=0;window.__failLoad=false;window.__failAccept=false;editor.callbacks.rpc=async(method,args)=>{if(method==='save_annotation'){window.__writeCount++;await new Promise(r=>setTimeout(r,100));}if(method==='load_annotation'){await new Promise(r=>setTimeout(r,100));if(window.__failLoad){window.__failLoad=false;throw new Error('模拟图片读取失败')}}return window.__baseEditorRPC(method,args)};rpc=async(method,args)=>{if(method==='accept_tracking_frame'&&window.__failAccept){window.__failAccept=false;throw new Error('模拟审核失败')}return window.__baseRPC(method,args)};window.__blank=0;window.__sampling=true;window.__sample=()=>{if(!window.__sampling)return;if(page==='editor'&&(!editor.image||!editor.canvas.width||!editor.canvas.height))window.__blank++;requestAnimationFrame(window.__sample)};requestAnimationFrame(window.__sample);void 0");
  await ev("window.__datasetThumbNodes=[...$('#filmstrip').children];void 0");
  await click('#save-annotation');await wait(()=>ev("editor.name==='img_01.png'&&!editor.approving&&!editor.opening"));
  check('Save button audits current image and automatically opens its successor',JSON.parse(fs.readFileSync(path.join(project,'annotations','img_00.json'))).checked===true);
  check('ordinary dataset save retains its existing decoded thumbnail nodes',await ev('window.__datasetThumbNodes.length>0&&window.__datasetThumbNodes.every(n=>n.isConnected)'));
  key('S');await wait(()=>ev("editor.name==='img_02.png'&&!editor.approving"));
  check('S shortcut also saves and advances once',await ev('window.__blank===0'));
  await ev("openImage('img_10.png')");await ev("$('#image-filter').value='pending';loadImages()");await click('#save-annotation');
  await wait(()=>ev("editor.name==='img_11.png'&&!editor.approving"));
  check('pending filter advances from the saved position after current item disappears',await ev("editor.name==='img_11.png'"));
  check('saved image stays in the filmstrip even when pending filter excludes it',await ev("!!$('#filmstrip').querySelector('[data-name=\"img_10.png\"]')"));
  await ev('editor.canvas.focus();void 0');key('A');await wait(()=>ev("editor.name==='img_10.png'&&!editor.opening"));
  check('A returns to just-saved image without changing the dataset filter',await ev("$('#image-filter').value==='pending'&&editor.data.checked"));
  await ev("editor.data.description='回看修正';editor.changed();void 0");await click('#save-annotation');await wait(()=>ev("editor.name==='img_11.png'&&!editor.approving"));
  check('resaving a reviewed image returns to the same pending successor',JSON.parse(fs.readFileSync(path.join(project,'annotations','img_10.json'))).description==='回看修正');
  await click('#editor-prev');await wait(()=>ev("editor.name==='img_10.png'&&!editor.opening"));await click('#editor-next');await wait(()=>ev("editor.name==='img_11.png'&&!editor.opening"));
  check('filmstrip arrows support saved-image backward and forward navigation',await ev("$('#image-filter').value==='pending'"));

  await ev("$('#image-filter').value='all';paging.page=0;loadImages()");await ev("openImage('img_23.png')");await click('#save-annotation');
  await wait(()=>ev("editor.name==='img_24.png'&&!editor.approving"));
  check('save advances across dataset pagination',await ev('paging.page===1'));
  await ev("openImage('img_29.png')");await click('#save-annotation');await wait(()=>ev('!editor.approving&&!editor.confirming'));
  check('last dataset image remains visible with completion notice',await ev("editor.name==='img_29.png'&&!!editor.image&&$('#toast').textContent.includes('最后一张')"));
  await ev("paging.page=0;loadImages()");await ev("openImage('img_05.png')");await ev('window.__failLoad=true;void 0');await click('#save-annotation');await wait(()=>ev('!editor.approving&&!editor.opening'));
  check('failed successor load retains the saved frame instead of leaving a black screen',await ev("editor.name==='img_05.png'&&editor.data.checked&&!!editor.image"));
  await click('#save-annotation');await wait(()=>ev("editor.name==='img_06.png'&&!editor.approving"));
  check('retry Save can advance after a temporary load error',await ev('window.__blank===0'));
  await ev("openImage('img_20.png')");await ev('window.__writeCount=0;void 0');for(let i=0;i<25;i++)key('S');
  await wait(()=>ev("editor.name==='img_21.png'&&!editor.approving"));
  check('rapid Save burst audits once and advances exactly one image',await ev('window.__writeCount===1&&window.__blank===0'));
  await screenshot('dataset-save-next.png');
  const record=await request('create_tracking',{path:path.join(folder,'cut.avi'),interval:.2});
  await request('save_annotation',{name:record.frames[0].name,annotation,base_hash:null,checked:false});
  await request('start_tracking',{id:record.id,name:record.frames[0].name,mode:'direct'});
  await wait(async()=>!['running','idle'].includes((await request('tracking_status')).status));await pause(200);
  let queue;await wait(async()=>{try{queue=await request('queue_tracking_review',{id:record.id});return true;}catch(error){if(error.message.includes('视频任务正在运行'))return false;throw error;}});assert.ok(queue.names.length>=4);
  await ev('api.state().then(update)');await ev('window.videoTracking.refresh()');await ev("go('video-review')");await click('#review-gallery .review-open');
  await wait(()=>ev(`editor.name===${JSON.stringify(queue.names[0])}&&!editor.opening`));
  // The first entry may involve an ordinary route mount, outside the sampling scope.
  await ev('window.__blank=0;void 0');await click('#save-annotation');
  await wait(()=>ev(`editor.name===${JSON.stringify(queue.names[1])}&&!editor.approving`));
  check('video review Save advances to the original next frame after queue refresh',await ev('window.__blank===0'));
  check('confirmed video frame remains available in the filmstrip',await ev(`!!$('#filmstrip').querySelector('[data-name="${queue.names[0]}"]')`));
  await ev('editor.canvas.focus();void 0');key('A');await wait(()=>ev(`editor.name===${JSON.stringify(queue.names[0])}&&!editor.opening`));
  check('A reopens the last confirmed video review frame',await ev("page==='editor'&&!!editor.image"));
  check('reopened confirmed frame retains its reviewed marker',await ev(`$('#filmstrip').querySelector('[data-name="${queue.names[0]}"] .film-status').textContent==='✓ 已审核'`));
  await ev("editor.data.description='视频回看修正';editor.changed();void 0");await click('#save-annotation');await wait(()=>ev(`editor.name===${JSON.stringify(queue.names[1])}&&!editor.approving`));
  const revised=await request('load_annotation',{name:queue.names[0]});check('confirmed video frame can be edited and saved again',revised.annotation.description==='视频回看修正');

  for(let i=0;i<25;i++)key('S');await wait(()=>ev(`editor.name===${JSON.stringify(queue.names[2])}&&!editor.approving`));
  check('rapid video-review Save burst advances one frame without skipping the next task',await ev('window.__blank===0'));
  await ev('window.__failAccept=true;void 0');await click('#save-annotation');await wait(()=>ev('!editor.approving&&!editor.confirming'));
  check('failed video audit stays on current frame for retry',await ev(`editor.name===${JSON.stringify(queue.names[2])}&&!!editor.image`));
  await click('#save-annotation');await wait(()=>ev(`editor.name===${JSON.stringify(queue.names[3])}&&!editor.approving`));
  await ev("window.__reviewOpenLog=[];window.__reviewBaseOpen=editor.open.bind(editor);editor.open=async name=>{window.__reviewOpenLog.push(name);return window.__reviewBaseOpen(name)};void 0");
  const remaining=(await request('video_sequences')).find(r=>r.id===record.id).review_frames.filter(n=>!queue.names.slice(0,3).includes(n));
  const last=remaining.at(-1);if(remaining.length>1)await request('remove_tracking_drafts',{names:remaining.slice(0,-1)});
  await ev('window.videoTracking.refresh()');await ev("go('video-review')");await wait(async()=>{await ev('window.videoTracking.refresh()');return ev("$('#review-total').textContent.startsWith('1 张')");});await click('#review-gallery .review-open');await wait(()=>ev(`editor.name===${JSON.stringify(last)}&&!editor.opening`));
  await ev('window.__blank=0;void 0');await click('#save-annotation');await wait(()=>ev('!editor.approving&&!editor.confirming'));
  check('final video review keeps its confirmed image and clearly reports completion',await ev(`editor.name===${JSON.stringify(last)}&&!!editor.image&&$('#canvas-review-count').textContent.includes('全部审核完成')&&window.__blank===0`));
  await screenshot('review-complete.png');await ev('window.__sampling=false;void 0');
 }catch(error){report.errors.push(error.stack);try{report.debug=await ev("({page,name:editor.name,toast:$('#toast').textContent,opening:!!editor.opening,requested:editor.requestedName,opens:window.__reviewOpenLog,root:state.project?.root,total:$('#review-total').textContent,tiles:[...document.querySelectorAll('#review-gallery .review-open')].map(n=>n.textContent)})");await screenshot('failure.png');}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
