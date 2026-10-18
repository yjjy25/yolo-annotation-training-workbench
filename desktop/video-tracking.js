/* Video route owns playback and tracking. Canvas receives only explicit review frames. */
(() => {
 let videoName=null,canvasName=null,reviewing=false,mountedVideo=false,routing=false;
 const surface=[$('.editor-toolbar'),$('.editor-grid')],videoHost=$('#tracking-editor-host'),canvasPage=$('#page-editor');
 videoHost.append($('#tracking-strip'),$('#video-timeline'));
 const reviewFrames=()=>records.flatMap(r=>{const frames=new Map(r.frames.map(f=>[f.name,f]));return (r.review_frames||[]).filter(n=>frames.has(n)&&!r.accepted?.[n]).map(name=>({record:r,...frames.get(name)}));});
 const localAccepted=new Map();let reviewSyncTimer;
 let records=[],root=null,job={status:'idle'},pending=false,polling=false,token=0,terminalKey='',creatingProject=false,previewBase=null,previewFrame=-1,lastPoll=0,seeking=false,seekHeld=false,seekTimer=null,seekRequest=null,stripToken=0,previewEpoch=0;
 const active=()=>records.find(r=>r.frames.some(f=>f.name===editor.name));
 const running=()=>pending||seeking||job.status==='running';
 const names={ready:'标注首帧',running:'正在追踪',paused:'等待修正',stopped:'已暂停',completed:'追踪完成',failed:'追踪失败'};
 function displayInfo(record){
  if(job.id===record.id&&['running','failed'].includes(job.status))return job;
  if(record.tracking.status==='running')return {...record.tracking,status:'stopped',message:'上次追踪已中断。已有结果保留，请检查已保存帧后继续。'};
  return record.tracking;
 }
 function lock(){
  const busy=page==='video'&&running();
  $('.editor-grid').inert=false;$('.editor-toolbar').inert=busy;
  for(const selector of ['.filmstrip','.inspector','#canvas-host'])$(selector).inert=busy;
  $('#tracking-stop').disabled=!busy||pending;$('#tracking-run').disabled=busy||!active();
  $('#tracking-create').disabled=busy||!state.project||state.project.task==='classify';
  $('#tracking-last').disabled=busy||!active();
  $('#tracking-forward').disabled=busy||!active();
  $('#tracking-run-mode').disabled=busy;
  $('#tracking-review').disabled=busy||!active();
 }
 function sync(){
  const record=active();$('#tracking-strip').hidden=page!=='video'||!record;
  if(record){
   const info=displayInfo(record);
   $('#tracking-phase').textContent=names[info.status]||'继续标注';
   $('#tracking-message').textContent=(info.error||info.message||'标注当前帧后继续追踪。')+(info.generated!=null?` 本轮已保存 ${info.generated} 张。`:'');
   $('#tracking-run').textContent=info.status==='ready'?'保存并开始追踪':'保存当前帧并继续';
  }
  const staged=record?.storage==='video-work';
  $('#auto-approve').disabled=true;$('#auto-approve').checked=true;
  $('#save-annotation').textContent=staged?'保存视频草稿':'保存草稿';
  $('#approve-annotation').textContent=staged?'确认当前帧，加入数据集':'确认无误，下一张 →';
  const inVideo=page==='video';
  $('#approve-annotation').hidden=inVideo;
  $('#remove-image').hidden=inVideo||!!staged;
  $('.approve-switch').hidden=true;
  $('#save-annotation').textContent=inVideo?'保存并确认当前帧':'保存审核，下一张 →';
  $('#canvas-source').hidden=inVideo||!reviewFrames().length;
  $('#canvas-source').value=reviewing?'video-review':'images';
  $('#canvas-review-note').hidden=page!=='editor'||!reviewing;
  $('#canvas-review-count').textContent=reviewFrames().length?`视频待微调 · 剩余 ${reviewFrames().length} 张 · 保存后自动下一张`:'视频待微调已全部审核完成 · 当前画面保留';
  confirmedStatus();lock();
 }
 function confirmedStatus(){
  const accepted=active()?.accepted?.[editor.name];
  if(accepted&&accepted.source_hash===editor.baseHash&&!editor.dirty&&!editor.saving)$('#save-status').textContent='已保存 · 已审核 · 已加入数据集';
 }
 function syncTimeline(record=active()){
  if(page!=='video'){if(active()||reviewing){$('#video-timeline').hidden=true;videoHost.append($('#video-timeline'));}return;}
  if(!record){$('#video-timeline').hidden=true;return;}
  const first=record.frames[0].frame;
  const stop=record.settings.end?Math.ceil(record.settings.end*record.fps):record.source_frames;
  const current=previewBase&&previewFrame>=0?previewFrame:(record.frames.find(f=>f.name===editor.name)?.frame??first);
  $('#video-timeline').hidden=false;$('#video-position').min=first;
  $('#video-position').max=Math.max(first,(stop||record.tracking.frame+1||first+1)-1);
  if(!seekHeld&&!seeking)$('#video-position').value=current;
  $('#video-prev').disabled=current<=first;$('#video-next').disabled=current>=Number($('#video-position').max);
  $('#video-time').textContent=`原帧 ${current} · ${(current/record.fps).toFixed(2)} 秒 · 拖动定位并修改`;
 }
 function render(){
  $('#tracking-project-note').textContent=state.project?`当前项目：${state.project.name} · ${taskNames[state.project.task]} · ${state.project.classes.join('、')}`:'先选择或新建项目，沿用项目中的类别和骨点模板。';
  if(state.project?.task==='classify')$('#tracking-project-note').textContent='整图分类不使用目标追踪，请使用数据页的视频抽帧。';
  const host=$('#tracking-sessions');host.replaceChildren();
  if(!records.length){const p=document.createElement('p');p.className='muted';p.textContent='还没有追踪视频，导入后会在这里保存进度。';host.append(p);}
  for(const record of records){
   const button=document.createElement('button');button.className='tracking-session';
   const title=document.createElement('strong'),detail=document.createElement('span');title.textContent=record.source_name;
   detail.textContent=`${names[displayInfo(record).status]||'继续标注'} · ${record.frames.length} 张待检查画面 · ${Object.keys(record.accepted||{}).length} 张已加入数据集`;
   const review=document.createElement('button');review.className='tracking-review-link';review.textContent='送到画布微调';review.disabled=running();review.onclick=()=>sendReview(record).catch(e=>toast(e.message));
   button.append(title,detail);button.disabled=running();button.onclick=()=>openRecord(record).catch(e=>toast(e.message));host.append(button,review);
  }
  sync();
  renderFilmstrip();renderReviewGallery();
 }
 async function refresh(){
  const projectRoot=state.project?.root,request=++token;
  if(!projectRoot){records=[];root=null;job={status:'idle'};render();return;}
  const [sequences,status]=await Promise.all([rpc('video_sequences'),rpc('tracking_status')]);
  if(request!==token||state.project?.root!==projectRoot)return;
  if(root!==projectRoot){terminalKey='';job={status:'idle'};}
  root=projectRoot;records=sequences.filter(s=>s.kind==='tracking');
  for(const record of records)for(const [name,accepted] of localAccepted.get(record.id)||[]){
   if(record.accepted?.[name]?.source_hash===accepted.source_hash)localAccepted.get(record.id).delete(name);
   else{record.accepted??={};record.accepted[name]=accepted;}
  }
  job=status;render();
 }
 async function openRecord(record,name,internal=false){
  if(running()&&!internal)throw new Error('请先暂停追踪，再切换画面。');
  await window.refreshVideoSequences();
  if(!record.frames.length){
   const first=await rpc('seek_tracking',{id:record.id,frame:Math.round(record.settings.start*record.fps)});
   await refresh();record=records.find(r=>r.id===record.id);name=first.name;
  }
  const target=name||record.tracking.name||record.frames[0].name;
  videoName=target;
  if(page!=='video')await go('video');
  $('#tracking-library').open=false;videoHost.hidden=false;
  await editor.open(target);
  renderFilmstrip();
  sync();
 }
 function restorePreview(){
  previewEpoch++;
  if(!previewBase)return;
  Object.assign(editor,previewBase);previewBase=null;previewFrame=-1;
  delete $('.editor-grid').dataset.trackingPreview;
  $('#image-name').textContent=editor.name||'';editor.fit();editor.list();editor.status();editor.hint();
 }
 async function showPreview(){
  const epoch=previewEpoch;
  const value=await rpc('tracking_preview',{frame:job.preview_frame});if(!value||value.frame===previewFrame)return;
  const image=new Image();image.src=value.image_url;await image.decode();
  if(epoch!==previewEpoch||seeking||seekHeld||job.status!=='running')return;
  if(!previewBase){
   previewBase=Object.fromEntries(['image','data','name','baseHash','proposal','selected','selectedMany','history','future','pose','pending','brush','dirty','nextOccluded'].map(key=>[key,editor[key]]));
  }
  editor.image=image;editor.data=value.annotation;editor.selected=-1;editor.selectedMany=[];editor.history=[];editor.future=[];editor.pose=null;editor.pending=[];editor.brush=[];editor.dirty=false;
  editor.fit();editor.list();editor.hint();
  $('.editor-grid').dataset.trackingPreview='true';
  if(!seekHeld&&!seeking){$('#video-position').value=value.frame;$('#video-timeline').hidden=false;}
  $('#video-time').textContent=`原帧 ${value.frame} · ${(value.frame/(job.fps||30)).toFixed(2)} 秒 · 可拖动定位修改`;
  $('#image-name').textContent='视频逐帧预览 · 原帧 '+value.frame;
  $('#save-status').textContent='实时预览 · 结果保存在视频页';
  $('#tracking-message').textContent=`正在播放原帧 ${value.frame}（${(value.frame/(job.fps||30)).toFixed(2)} 秒），已保存 ${job.generated||0} 张。`;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  // Each acknowledged frame has been rendered; the worker cannot skip ahead.
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,1000/(job.fps||30))));
  if(epoch!==previewEpoch||seeking||seekHeld)return;
  previewFrame=value.frame;
  window.dispatchEvent(new CustomEvent('tracking-preview-shown',{detail:{frame:value.frame}}));
  await rpc('ack_tracking_preview',{frame:value.frame});
 }
 async function tick(){
  if(polling||pending||seeking||seekHeld||seekRequest||routing||page!=='video'||!state.project)return;
  if(job.mode!=='play'&&Date.now()-lastPoll<650)return;
  lastPoll=Date.now();
  polling=true;const projectRoot=state.project.root;
  try{
   const result=await rpc('tracking_status');if(state.project?.root!==projectRoot||routing||pending||seeking||seekHeld||page!=='video')return;
   const wasRunning=job.status==='running';
   if(wasRunning&&result.status!=='running'&&result.status!=='idle')pending=true;
   job=result;sync();
   if(result.status==='running'&&result.mode==='play'&&result.preview_frame!=null)await showPreview();
   if(result.status!=='idle'&&result.status!=='running'){
    const key=JSON.stringify([root,result.id,result.status,result.frame,result.generated]);
    if(wasRunning&&terminalKey!==key){
     restorePreview();
     terminalKey=key;await refresh();await api.state().then(update);galleryKey='';await loadImages();
     await window.refreshVideoSequences();
     const record=records.find(r=>r.id===result.id);
     if(page==='video'&&!routing&&record&&result.name)await openRecord(record,result.name,true);
     toast(result.error||result.message||'追踪已暂停，请检查标注。');
    }
   }
  }catch(e){restorePreview();job={status:'failed',error:e.message};try{await rpc('stop_video');}catch{}window.refreshVideoSequences?.().catch(()=>{});sync();}
  finally{pending=false;polling=false;sync();}
 }
 $('#tracking-choose').onclick=async()=>{const path=await api.choose('video');if(path)$('#tracking-path').value=path;};
 $('#tracking-new-project').onclick=async()=>{try{await showNew();creatingProject=true;}catch(e){toast(e.message);}};
 $('#project-dialog').addEventListener('cancel',()=>{creatingProject=false;});
 $('#close-project-dialog').addEventListener('click',()=>{creatingProject=false;});
 $('#tracking-form').onsubmit=async event=>{
  event.preventDefault();if(running())return;
  pending=true;lock();$('#tracking-create-status').textContent='正在读取视频首帧…';
  try{
   await editor.save();
   const record=await rpc('create_tracking',{path:$('#tracking-path').value.trim(),start:Number($('#tracking-start').value),end:Number($('#tracking-end').value),interval:Number($('#tracking-interval').value),profile:$('#tracking-profile').value});
   pending=false;await api.state().then(update);galleryKey='';await loadImages();await refresh();await openRecord(record);
   $('#tracking-create-status').textContent='已导入，直接在此页标记首帧。';
  }catch(e){$('#tracking-create-status').textContent=e.message;}
  finally{pending=false;render();}
 };
 $('#tracking-run').onclick=async()=>{
  if(running())return;const record=active();if(!record)return;
  pending=true;lock();
  try{
   if(editor.pose)throw new Error('请先完成骨点标注，或按 K 跳过未知点。');
   await editor.save();if(editor.dirty)throw new Error('标注尚未保存，请完成当前轮廓后重试。');
   const result=await rpc('start_tracking',{id:record.id,name:editor.name,mode:$('#tracking-run-mode').value});
   job={...result,name:editor.name,generated:0,message:'正在定位起始帧…'};
   terminalKey='';
  }catch(e){toast(e.message);}
  finally{pending=false;sync();}
 };
 $('#tracking-stop').onclick=async()=>{try{await rpc('stop_video');$('#tracking-message').textContent='正在暂停，已有结果会保留…';}catch(e){toast(e.message);}};
 $('#tracking-home').onclick=()=>{$('#tracking-library').open=!$('#tracking-library').open;};
 $('#tracking-review').onclick=()=>sendReview().catch(e=>toast(e.message));
 $('#tracking-last').onclick=async()=>{const record=active();if(record)try{await openRecord(record);}catch(e){toast(e.message);}};
 $('#tracking-forward').onclick=async()=>{
  const record=active();if(!record||running())return;
  try{
   await editor.save();const result=await rpc('advance_tracking',{id:record.id,name:editor.name});
   job={status:'idle'};await refresh();job={status:'idle'};
   await api.state().then(update);galleryKey='';await loadImages();
   await openRecord(records.find(r=>r.id===result.id),result.name);
  }catch(e){toast(e.message);}
 };
 async function performSeek(){
  if(seeking||!seekRequest)return;
  const request=seekRequest;seekRequest=null;seeking=true;lock();
  try{
   if(job.status==='running')await rpc('stop_video');
   if(previewBase)restorePreview();
   await editor.save();
   const result=await rpc('seek_tracking',request);
   job={status:'idle'};await refresh();job={status:'idle'};
   await openRecord(records.find(r=>r.id===request.id),result.name,true);
   syncTimeline();
  }catch(e){restorePreview();toast(e.message);}
  finally{seeking=false;sync();syncTimeline();if(seekRequest)performSeek();}
 }
 function seekFrame(frame,id=active()?.id){
  if(!id)return Promise.resolve();
  clearTimeout(seekTimer);seekRequest={id,frame:Math.round(frame)};
  return performSeek();
 }
 $('#video-position').addEventListener('pointerdown',()=>{
  if(active()?.storage!=='video-work')return;
  seekHeld=true;previewEpoch++;if(job.status==='running')rpc('stop_video').catch(e=>toast(e.message));
 });
 $('#video-position').oninput=()=>{
  if(active()?.storage!=='video-work')return;
  const frame=Number($('#video-position').value);$('#video-time').textContent=`定位原帧 ${frame}…`;
  clearTimeout(seekTimer);seekTimer=setTimeout(()=>seekFrame(frame),90);
 };
 $('#video-position').addEventListener('pointerup',()=>{if(!seekHeld)return;seekHeld=false;seekFrame(Number($('#video-position').value));});
 $('#video-position').addEventListener('pointercancel',()=>{seekHeld=false;});
 function acceptCurrent(){
  return editor.runConfirmation(async()=>{
   const record=active(),name=editor.name,root=state.project?.root;
   if(!record||running())return false;
   try{
    if(editor.pose)throw new Error('请先完成骨点，或跳过无法定位的点。');
    await editor.save();if(editor.dirty)throw new Error('请先完成当前轮廓。');
    const result=await rpc('accept_tracking_frame',{id:record.id,name,update_confirmed:true});
    if(state.project?.root!==root)return false;
    const accepted={name:result.name,source_hash:editor.baseHash};
    const current=records.find(r=>r.id===record.id)||record;current.accepted??={};current.accepted[name]=accepted;
    if(!localAccepted.has(record.id))localAccepted.set(record.id,new Map());localAccepted.get(record.id).set(name,accepted);
    clearTimeout(reviewSyncTimer);reviewSyncTimer=setTimeout(()=>{if(state.project?.root===root)Promise.all([api.state().then(update),refresh()]).catch(e=>toast(e.message));},350);
    renderFilmstrip();sync();
    toast(result.already?'此帧已经审核并加入数据集。':result.updated?'已保存并审核，数据集中的当前帧已更新。':'已保存并审核，当前帧已加入数据集。');return true;
   }catch(e){toast(e.message);return false;}
  });
 }
 document.addEventListener('keydown',event=>{
  if(!running()||page!=='video')return;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.key==='Escape')$('#tracking-stop').click();
 },true);
 const previousStatus=editor.status.bind(editor);
 editor.status=()=>{previousStatus();confirmedStatus();};
 const previousOpen=editor.open.bind(editor);
 editor.open=async name=>{if(job.status==='running')throw new Error('请先暂停追踪，再切换图片。');restorePreview();const opened=await previousOpen(name);sync();syncTimeline();return opened;};
 const previousConfirmSave=editor.confirmSave.bind(editor);
 editor.confirmSave=()=>active()?.storage==='video-work'?acceptCurrent():previousConfirmSave();
 const previousFilmstrip=renderFilmstrip;
 renderFilmstrip=()=>{
  ++stripToken;
  if(page!=='video'&&!reviewing){$('.filmstrip-title').firstChild.textContent='图片 ';return previousFilmstrip();}
  const frames=page==='video'?(active()?.frames||[]):reviewFrames(),projectRoot=state.project?.root;
  $('.filmstrip-title').firstChild.textContent=page==='video'?'视频帧 ':'待微调 ';
  const host=$('#filmstrip'),old=new Map([...host.children].map(node=>[node.dataset.name,node]));
  const at=frames.findIndex(f=>f.name===editor.name),start=Math.max(0,at-10),wanted=frames.slice(start,start+22),keep=new Set();
  for(let i=0;i<wanted.length;i++){
   const frame=wanted[i];let button=old.get(frame.name);
   if(!button){
    button=document.createElement('button');button.dataset.name=frame.name;
    const photo=document.createElement('img'),text=document.createElement('small');photo.alt=`原帧 ${frame.frame}`;text.textContent=`原帧 ${frame.frame} · 待确认`;button.append(photo,text);
    button.onclick=()=>page==='video'?seekFrame(frame.frame,frame.record?.id||active()?.id):openReview(frame.name);
    reviewThumbnail(frame.name,160).then(asset=>{if(state.project?.root===projectRoot)photo.src=asset.url;}).catch(()=>{photo.alt='缩略图读取失败，可点击重试';});
   }
   button.className='film-item'+(frame.name===editor.name?' selected':'');keep.add(button);
   if(host.children[i]!==button)host.insertBefore(button,host.children[i]||null);
  }
  for(const button of [...host.children])if(!keep.has(button))button.remove();
 };
 function prepareSaveNext(){
  if(page==='video')return async()=>{}; // Keep the current seed available for tracking.
  if(page!=='editor'||!reviewing)return undefined;
  const name=editor.name,root=state.project?.root,frames=reviewFrames(),at=frames.findIndex(f=>f.name===name);
  const successors=[...frames.slice(at+1),...frames.slice(0,Math.max(0,at))].map(f=>f.name);
  if(successors[0])editor.prefetchImage(successors[0]).catch(()=>{});
  return async()=>{
   if(page!=='editor'||state.project?.root!==root||editor.name!==name)return;
   const remaining=new Set(reviewFrames().map(f=>f.name));
   const next=successors.find(n=>remaining.has(n))||reviewFrames().find(f=>f.name!==name)?.name;
   if(next)await openReview(next);
   else{renderFilmstrip();sync();toast('视频待微调已全部审核完成，当前画面已保留。');}
  };
 }
 async function openReview(name){
  reviewing=true;canvasName=name;
  if(page!=='editor')await go('editor');
  if(page!=='editor')return;
  await editor.open(name);renderFilmstrip();sync();
  const frames=reviewFrames(),at=frames.findIndex(f=>f.name===editor.name);
  for(const next of frames.slice(at+1,at+3))editor.prefetchImage(next.name).catch(()=>{});
 }
 async function sendReview(record=active()){
  if(!record||running())throw new Error('请先暂停追踪，再送到画布微调。');
  await editor.save();
  if(editor.pose||editor.dirty)throw new Error('请先完成当前标记。');
  const result=await rpc('queue_tracking_review',{id:record.id});
  await refresh();
  await openReview(result.names.includes(editor.name)?editor.name:result.names[0]);
  toast(`已将 ${result.count} 张标注帧送到画布微调，确认后才会加入数据集。`);
 }
 async function beforeNavigate(next){
  if(page==='video'&&next!=='video'){
   routing=true;
   try{
    if(pending||seeking)throw new Error('正在处理当前视频帧，请稍后切换。');
    const wasRunning=job.status==='running';
    if(wasRunning){
     await rpc('stop_video');
     const deadline=Date.now()+5000;
     do{job=await rpc('tracking_status');if(job.status!=='running')break;await new Promise(r=>setTimeout(r,50));}while(Date.now()<deadline);
     if(job.status==='running')throw new Error('视频正在暂停，请稍后切换。');
    }
    restorePreview();videoName=wasRunning?(job.name||editor.name):editor.name;
   }finally{routing=false;}
  }else if(page==='editor'&&next!=='editor')canvasName=editor.name;
 }
 async function mount(next){
  const inVideo=next==='video';
  if(inVideo!==mountedVideo){
   if(editor.confirming)await editor.confirming;
   editor.forget();
   if(inVideo){videoHost.prepend(surface[0]);videoHost.append(surface[1]);videoHost.insertBefore($('#video-timeline'),surface[1]);}
   else for(const node of surface)canvasPage.append(node);
   mountedVideo=inVideo;
   if(inVideo){
    videoHost.hidden=!videoName;
    if(videoName)await editor.open(videoName);
   }else if(next==='editor'){
    const frames=reviewFrames();
    const name=reviewing?(frames.find(f=>f.name===canvasName)?.name||frames[0]?.name):canvasName;
    if(!name)reviewing=false;
    if(name)await editor.open(name);
   }
  }
  if(next==='editor'&&!editor.name){
   const frames=reviewFrames(),name=reviewing?(frames.find(f=>f.name===canvasName)?.name||frames[0]?.name):canvasName;
   if(name)await editor.open(name);else reviewing=false;
  }
  sync();syncTimeline();renderFilmstrip();
  requestAnimationFrame(()=>editor.fit());
 }
 function navigateFrame(step){
  if(page==='video'&&active())return seekFrame(Number($('#video-position').value)+step);
  if(page==='editor'&&reviewing){
   const frames=reviewFrames(),at=frames.findIndex(f=>f.name===editor.name),frame=frames[Math.max(0,Math.min(frames.length-1,at+step))];
   return frame?openReview(frame.name):Promise.resolve();
  }
  return null;
 }
 $('#canvas-source').onchange=async()=>{
  try{
   await editor.save();
   if($('#canvas-source').value==='video-review'&&reviewFrames()[0])await openReview(reviewFrames()[0].name);
   else{reviewing=false;editor.forget();if(items[0])await editor.open(items[0].name);renderFilmstrip();sync();}
  }catch(e){toast(e.message);}
 };
 const originalNavigate=navigate;
 let navigationDelta=0,navigationTask=null;
 navigate=step=>{
  navigationDelta+=step;
  if(navigationTask)return navigationTask;
  const root=state.project?.root,origin=page;
  let operation;
  operation=Promise.resolve().then(async()=>{
   while(navigationDelta&&state.project?.root===root&&page===origin){
    const delta=navigationDelta;navigationDelta=0;
    await (navigateFrame(delta)??originalNavigate(delta));
   }
  }).catch(e=>toast(e.message)).finally(()=>{navigationDelta=0;if(navigationTask===operation)navigationTask=null;});
  navigationTask=operation;return operation;
 };
 editor.callbacks.navigate=step=>navigate(step);
 let reviewPage=0,reviewToken=0,removingFrames=false,reviewGalleryKey='';
 const reviewSelection=new Set(),reviewThumbnails=new Map();
 function reviewThumbnail(name,width=320){
  const key=state.project?.root+'|'+name+'|'+width;
  if(!reviewThumbnails.has(key)){
   const promise=api.asset(name,width).catch(error=>{reviewThumbnails.delete(key);throw error;});
   reviewThumbnails.set(key,promise);
   if(reviewThumbnails.size>240)reviewThumbnails.delete(reviewThumbnails.keys().next().value);
  }
  return reviewThumbnails.get(key);
 }
 function renderReviewGallery(){
  if(page!=='video-review')return;
  const select=$('#review-video-filter'),previous=select.value;
  select.replaceChildren(new Option('全部视频',''));
  for(const record of records)if(record.review_frames?.length)select.add(new Option(record.source_name,record.id));
  if([...select.options].some(o=>o.value===previous))select.value=previous;
  const query=$('#review-search').value.trim().toLowerCase();
  const all=reviewFrames();
  for(const name of reviewSelection)if(!all.some(f=>f.name===name))reviewSelection.delete(name);
  const filtered=all.filter(f=>(!select.value||f.record.id===select.value)&&(!query||`${f.name} ${f.frame} ${f.record.source_name}`.toLowerCase().includes(query)));
  const pages=Math.max(1,Math.ceil(filtered.length/24));reviewPage=Math.min(reviewPage,pages-1);
  const frames=filtered.slice(reviewPage*24,(reviewPage+1)*24),host=$('#review-gallery');
  $('#review-total').textContent=`${filtered.length} 张待微调 · 已选 ${reviewSelection.size} 张`;
  $('#review-page-number').textContent=`${reviewPage+1} / ${pages}`;
  $('#review-prev').disabled=reviewPage===0;$('#review-next').disabled=reviewPage>=pages-1;
  $('#review-remove-selected').disabled=removingFrames||!reviewSelection.size;
  $('#review-select-page').checked=!!frames.length&&frames.every(f=>reviewSelection.has(f.name));
  $('#review-select-page').indeterminate=frames.some(f=>reviewSelection.has(f.name))&&!$('#review-select-page').checked;
  const galleryKey=JSON.stringify([state.project?.root,removingFrames,!!all.length,frames.map(f=>[f.name,f.frame,f.record.source_name,reviewSelection.has(f.name)])]);
  if(galleryKey===reviewGalleryKey)return;
  reviewGalleryKey=galleryKey;const token=++reviewToken;host.replaceChildren();
  if(!frames.length){const empty=document.createElement('div');empty.className='empty-gallery';empty.textContent=all.length?'没有符合条件的帧':'暂无待微调帧。在视频追踪页点击“送到画布微调”。';host.append(empty);}
  for(const frame of frames){
   const tile=document.createElement('div');tile.className='image-tile review-tile';
   const open=document.createElement('button');open.className='review-open';open.disabled=removingFrames;
   const photo=document.createElement('img');photo.alt=`原帧 ${frame.frame}`;const text=document.createElement('span');text.textContent=`${frame.record.source_name} · 原帧 ${frame.frame}`;
   open.append(photo,text);open.onclick=()=>openReview(frame.name).catch(e=>toast(e.message));
   const actions=document.createElement('div');actions.className='review-tile-actions';
   const label=document.createElement('label');label.className='check-label';const box=document.createElement('input');box.type='checkbox';box.checked=reviewSelection.has(frame.name);box.disabled=removingFrames;box.setAttribute('aria-label',`选择原帧 ${frame.frame}`);
   box.onchange=()=>{box.checked?reviewSelection.add(frame.name):reviewSelection.delete(frame.name);renderReviewGallery();};label.append(box,document.createTextNode('选择'));
   const remove=document.createElement('button');remove.textContent='移除';remove.className='review-remove';remove.disabled=removingFrames;remove.onclick=()=>removeReviewFrames([frame.name]);
   actions.append(label,remove);tile.append(open,actions);host.append(tile);
   reviewThumbnail(frame.name).then(asset=>{if(token===reviewToken)photo.src=asset.url;}).catch(()=>{if(token===reviewToken)photo.alt='缩略图读取失败，请刷新';});
  }
 }
 async function removeReviewFrames(names){
  if(removingFrames||running())return;
  if(!await confirmRemoval(names.length===1?names[0]:`选中的 ${names.length} 张帧`,true))return;
  removingFrames=true;renderReviewGallery();
  try{
   if(editor.confirming)await editor.confirming;
   await editor.save();
   const result=await rpc('remove_tracking_drafts',{names});
   if(result.names.includes(editor.name)){editor.forget();canvasName=null;}
   for(const name of result.names)reviewSelection.delete(name);
   await refresh();toast(`已移除 ${result.count} 张视频待微调帧，可从视频待确认区的 removed 文件夹取回。`);
  }catch(e){toast(e.message);}finally{removingFrames=false;renderReviewGallery();}
 }
 $('#review-overview').onclick=()=>go('video-review');
 $('#review-search').oninput=()=>{reviewPage=0;renderReviewGallery();};
 $('#review-video-filter').onchange=()=>{reviewPage=0;renderReviewGallery();};
 $('#review-prev').onclick=()=>{reviewPage--;renderReviewGallery();};$('#review-next').onclick=()=>{reviewPage++;renderReviewGallery();};
 $('#review-refresh').onclick=()=>refresh().catch(e=>toast(e.message));
 $('#review-remove-selected').onclick=()=>removeReviewFrames([...reviewSelection]);
 $('#review-select-page').onchange=()=>{
  const query=$('#review-search').value.trim().toLowerCase(),id=$('#review-video-filter').value;
  const frames=reviewFrames().filter(f=>(!id||f.record.id===id)&&(!query||`${f.name} ${f.frame} ${f.record.source_name}`.toLowerCase().includes(query))).slice(reviewPage*24,(reviewPage+1)*24);
  for(const frame of frames)$('#review-select-page').checked?reviewSelection.add(frame.name):reviewSelection.delete(frame.name);
  renderReviewGallery();
 };
 const previousProject=editor.setProject.bind(editor);
 editor.setProject=project=>{if(root!==project?.root){videoName=null;canvasName=null;reviewing=false;reviewPage=0;reviewSelection.clear();reviewThumbnails.clear();localAccepted.clear();clearTimeout(reviewSyncTimer);}previousProject(project);if(root!==project?.root)refresh().catch(e=>toast(e.message));};
 window.videoTracking={refresh,sync,prepareSaveNext,seekFrame,syncTimeline,acceptCurrent,beforeNavigate,mount,navigate:navigateFrame,ownsTimeline:()=>page==='video'||reviewing,imageOpened:name=>{if(!reviewFrames().some(f=>f.name===name))reviewing=false;canvasName=name;sync();},createdProject:()=>{if(!creatingProject)return false;creatingProject=false;go('video');return true;}};
 refresh().catch(e=>toast(e.message));setInterval(tick,80);
})();
