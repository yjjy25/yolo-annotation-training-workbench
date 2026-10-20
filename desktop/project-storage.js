/* Recycle thumbnails, project disk usage and actions remain near the top. */
(() => {
 let snapshot=null,busy=false,scanToken=0,observer=null,previewToken=0;
 const dialog=$('#project-storage-dialog'),permanent=$('#permanent-delete-dialog'),preview=$('#recycle-preview-dialog');
 const format=bytes=>{if(bytes===null||bytes===undefined)return '无法统计';if(bytes<1024)return bytes+' B';const unit=['KB','MB','GB','TB'];let value=bytes/1024,index=0;while(value>=1024&&index<3){value/=1024;index++;}return value.toFixed(2)+' '+unit[index];};
 const checked=()=>{const keys=new Set([...$('#project-storage-targets').querySelectorAll('input:checked')].map(i=>i.dataset.key));return (snapshot?.targets||[]).filter(t=>keys.has(t.key));};
 const available=()=>(snapshot?.targets||[]).filter(t=>!t.blocked);
 const imageMapping=item=>item.mappings.find(m=>/(^|\/)images\/[^/]+\.(png|jpe?g|bmp|webp|tiff?)$/i.test(m.destination));
 async function confirmPermanent(paths,summary,projectRoot){
  $('#permanent-delete-summary').textContent=summary;$('#permanent-delete-paths').textContent=paths.join('\n');$('#permanent-delete-ack').checked=false;$('#permanent-delete-confirm').disabled=true;permanent.returnValue='';permanent.showModal();
  return new Promise(resolve=>permanent.addEventListener('close',()=>resolve(permanent.returnValue==='delete'&&$('#permanent-delete-ack').checked&&state.project?.root===projectRoot),{once:true}));
 }
 function controls(){
  const total=available().length,selected=checked().length;
  $('#project-storage-refresh').disabled=$('#project-storage-close').disabled=$('#project-storage-exit').disabled=busy;
  const all=$('#project-storage-all');all.disabled=busy||!total;all.checked=!!total&&selected===total;all.indeterminate=selected>0&&selected<total;
  $('#project-storage-selected').textContent=`已选 ${selected} / ${total} 项`;
  for(const input of $('#project-storage-targets').querySelectorAll('input,.storage-item-restore'))input.disabled=busy||!!input.dataset.blocked;
  $('#project-storage-restore').disabled=$('#project-storage-purge').disabled=busy||!selected;
  $('#project-storage-restore-all').disabled=$('#project-storage-purge-all').disabled=busy||!total;
 }
 async function showPreview(item,mapping){
  const root=snapshot?.project_root,token=++previewToken;
  $('#recycle-preview-name').textContent=item.label;$('#recycle-preview-status').textContent='正在加载图片…';$('#recycle-preview-image').hidden=true;$('#recycle-preview-image').removeAttribute('src');preview.showModal();
  try{const asset=await api.recycleAsset(root,mapping.source,512);if(token!==previewToken||state.project?.root!==root||!preview.open)return;$('#recycle-preview-image').src=asset.url;$('#recycle-preview-image').hidden=false;$('#recycle-preview-status').textContent='';}
  catch(error){if(token===previewToken)$('#recycle-preview-status').textContent='图片暂时无法预览：'+error.message;}
 }
 function thumbnail(item,root,token){
  const mapping=imageMapping(item),box=document.createElement(mapping?'button':'span');box.className='storage-thumbnail';
  if(!mapping){box.textContent=item.label.startsWith('模型')?'模型':'文件';return box;}
  box.type='button';box.title='点击放大预览';box.setAttribute('aria-label','预览 '+item.label);box.onclick=e=>{e.preventDefault();showPreview(item,mapping);};
  const img=document.createElement('img'),hint=document.createElement('span');img.alt=item.label;img.hidden=true;hint.textContent='加载图片…';box.append(img,hint);
  const load=async()=>{try{const asset=await api.recycleAsset(root,mapping.source,160);if(token!==scanToken||state.project?.root!==root||!box.isConnected)return;img.src=asset.url;img.hidden=false;hint.hidden=true;}catch{if(box.isConnected){hint.textContent='无法预览';box.title='图片可能损坏，仍可恢复或清空';}}};
  box.loadThumbnail=load;observer.observe(box);return box;
 }
 async function scan(){
  if(busy)return;const projectRoot=state.project?.root,token=++scanToken;if(!projectRoot)return;
  busy=true;snapshot=null;observer?.disconnect();$('#project-storage-targets').replaceChildren();$('#project-storage-usage').replaceChildren();$('#project-storage-total').textContent='正在统计…';$('#project-storage-files').textContent='';$('#project-storage-status').textContent='正在统计项目文件大小…';$('#project-storage-root').textContent=projectRoot;controls();
  try{
   const result=await rpc('project_storage');if(token!==scanToken||state.project?.root!==projectRoot)return;snapshot=result;
   $('#project-storage-total').textContent=(result.incomplete?.length?'至少 ':'')+format(result.total_bytes);
   $('#project-storage-files').textContent=`${result.total_files} 个文件 · 含回收站、模型、训练快照及其他项目文件`+(result.incomplete?.length?'；部分文件无法统计':'');
   for(const item of result.usage){const row=document.createElement('div');row.className='storage-usage-row';const name=document.createElement('span'),size=document.createElement('strong');name.textContent=item.label;size.textContent=format(item.bytes);row.append(name,size);$('#project-storage-usage').append(row);}
   observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);entry.target.loadThumbnail();}},{root:dialog,rootMargin:'200px'});
   const list=$('#project-storage-targets');let reclaim=0;
   for(const item of result.targets){
    const row=document.createElement('div');row.className='storage-target';const input=document.createElement('input');input.type='checkbox';input.dataset.key=item.key;input.dataset.blocked=item.blocked||'';input.setAttribute('aria-label','选择 '+item.label);input.onchange=controls;
    const detail=document.createElement('span');detail.className='storage-item-detail';const name=document.createElement('strong'),path=document.createElement('small');name.textContent=`${item.label} · ${format(item.bytes)} · ${item.files} 个文件`;path.textContent=item.path;detail.append(name,path);detail.onclick=()=>{if(!input.disabled){input.checked=!input.checked;controls();}};
    const restore=document.createElement('button');restore.type='button';restore.className='storage-item-restore';restore.textContent='恢复';restore.dataset.blocked=item.blocked||'';restore.onclick=()=>restoreItems([item]);row.append(input,thumbnail(item,projectRoot,token),detail,restore);list.append(row);if(!item.blocked)reclaim+=item.bytes;
   }
   if(!result.targets.length){const p=document.createElement('p');p.textContent='回收站为空。';list.append(p);}
   $('#project-storage-status').textContent=`回收站占用：${format(reclaim)}。永久清空后释放对应磁盘空间。`;
  }catch(error){$('#project-storage-total').textContent='统计失败';$('#project-storage-status').textContent=error.message;}
  finally{busy=false;controls();}
 }
 async function purgeItems(targets){
  if(busy||!snapshot||!targets.length)return;const projectRoot=snapshot.project_root;
  if(!await confirmPermanent(targets.flatMap(t=>t.paths||[t.path]),`永久清空 ${targets.length} 项回收站内容，文件大小合计 ${format(targets.reduce((sum,t)=>sum+t.bytes,0))}？此操作无法恢复。`,projectRoot))return;
  busy=true;controls();
  try{const result=await rpc('cleanup_project',{project_root:projectRoot,confirm_permanent:true,targets:targets.map(t=>({key:t.key,signature:t.signature}))});toast(`已永久清空 ${result.count} 项，清理文件大小 ${format(result.bytes)}。`+(result.failed.length?' 部分文件未能清理，请重新扫描。':''));}
  catch(error){toast(error.message);}finally{busy=false;await scan();}
 }
 async function restoreItems(targets,confirm=true){
  if(busy||!snapshot||!targets.length)return;const projectRoot=snapshot.project_root;
  if(confirm){const confirmation=$('#recycle-restore-dialog');$('#recycle-restore-paths').textContent=targets.flatMap(t=>t.mappings.map(m=>m.destination)).join('\n');confirmation.returnValue='';confirmation.showModal();const accepted=await new Promise(resolve=>confirmation.addEventListener('close',()=>resolve(confirmation.returnValue==='restore'),{once:true}));if(!accepted)return;}
  if(state.project?.root!==projectRoot)return;busy=true;controls();try{
   await editor.save();const result=await rpc('restore_recycle',{project_root:projectRoot,targets:targets.map(t=>({key:t.key,signature:t.signature}))});
   await api.state().then(update);galleryKey='';await loadImages();modelKey='';await refreshModels();await window.artifactManager?.refreshModels();await refreshValidationPlots();await window.videoTracking?.refresh();
   toast(`已恢复 ${result.count} 项。`+(result.failed.length?' 未恢复：'+result.failed.map(f=>f.error).join('；'):''));
  }catch(error){toast(error.message);}finally{busy=false;await scan();}
 }
 $('#project-storage-open').onclick=()=>{if(!state.project){toast('请先打开项目。');return;}dialog.showModal();scan();};
 $('#project-storage-close').onclick=$('#project-storage-exit').onclick=()=>{if(!busy)dialog.close();};dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});$('#project-storage-refresh').onclick=scan;
 $('#permanent-delete-ack').onchange=e=>{$('#permanent-delete-confirm').disabled=!e.target.checked;};
 $('#project-storage-all').onchange=e=>{for(const input of $('#project-storage-targets').querySelectorAll('input:not(:disabled)'))input.checked=e.target.checked;controls();};
 $('#project-storage-restore').onclick=()=>restoreItems(checked());$('#project-storage-purge').onclick=()=>purgeItems(checked());
 $('#project-storage-restore-all').onclick=()=>restoreItems(available(),false);$('#project-storage-purge-all').onclick=()=>purgeItems(available());
 $('#recycle-preview-close').onclick=()=>preview.close();preview.addEventListener('close',()=>{previewToken++;$('#recycle-preview-image').removeAttribute('src');});
 window.projectStorage={confirmPermanent,format};
})();
