/* Dataset selection is scoped to the project and survives gallery pagination. */
(() => {
 const selected=new Set();let root=null,busy=false;
 const dialog=$('#dataset-remove-dialog');
 function sync(){
  if(root!==state.project?.root){root=state.project?.root;selected.clear();}
  for(const tile of $('#gallery').querySelectorAll('.image-tile')){
   const checked=selected.has(tile.dataset.name);tile.classList.toggle('batch-selected',checked);tile.querySelector('.tile-select').checked=checked;
  }
  const count=items.filter(item=>selected.has(item.name)).length,selectPage=$('#dataset-select-page');
  selectPage.checked=items.length>0&&count===items.length;selectPage.indeterminate=count>0&&count<items.length;selectPage.disabled=busy||!items.length;
  $('#dataset-selected-count').textContent=`已选 ${selected.size} 张`;
  $('#dataset-clear-selection').disabled=busy||!selected.size;$('#dataset-remove-selected').disabled=busy||!selected.size;
  $('#dataset-remove-all').disabled=busy||!state.project?.counts.total;
  markCurrent();
 }
 function markCurrent(){
  if(!editor.name)return;
  const button=[...$('#filmstrip').children].find(b=>b.dataset.name===editor.name);if(!button)return;
  const annotated=!!editor.data?.shapes?.length||Object.values(editor.data?.flags||{}).some(v=>v===true);
  const checked=editor.data?.checked||window.videoTracking?.isAccepted?.(editor.name);
  const status=checked&&!editor.dirty?'checked':annotated?'draft':'unlabeled';setFilmMarker(button,status,annotated);
 }
 async function remove(all=false){
  if(busy)return;sync();const projectRoot=root,names=[...selected],count=all?state.project?.counts.total:names.length;
  if(!count)return;
  $('#dataset-remove-question').textContent=all?`移除整个数据集的全部 ${count} 张图片？包含当前筛选和分页中未显示的图片。`:`移除选中的 ${count} 张图片？选择可包含其他分页中的图片。`;
  $('#dataset-remove-confirm').textContent=all?`确认全部移除 ${count} 张`:`确认移除 ${count} 张`;
  dialog.returnValue='';dialog.showModal();
  const accepted=await new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='remove'),{once:true}));
  if(!accepted||state.project?.root!==projectRoot)return;
  busy=true;sync();$('#page-data').inert=true;
  try{
   if(editor.confirming)await editor.confirming;
   await editor.save();if(editor.dirty)throw new Error('请先完成并保存当前标注，再移除图片。');
   const request={project_root:projectRoot,...(all?{all:true,expected_count:count}:{names})};
   const result=await rpc('remove_images',request);
   if(state.project?.root!==projectRoot)return;
   for(const name of result.names){selected.delete(name);window.canvasNavigation?.forget(name);}
   if(result.names.includes(editor.name))editor.forget();
   await api.state().then(update);galleryKey='';await loadImages();
   toast((result.purged?`已永久删除 ${result.count} 张图片，不再放入移除区。`:`已移除 ${result.count} 张图片，可在“数据与标注 → 回收站”恢复。`)+(result.failed.length?` ${result.failed.length} 张未成功：${result.failed.map(f=>f.name+'：'+f.error).join('；')}`:''));
  }catch(error){toast(error.message);}
  finally{busy=false;$('#page-data').inert=false;sync();}
 }
 $('#dataset-select-page').onchange=event=>{for(const item of items)event.target.checked?selected.add(item.name):selected.delete(item.name);sync();};
 $('#dataset-clear-selection').onclick=()=>{selected.clear();sync();};
 $('#dataset-remove-selected').onclick=()=>remove();$('#dataset-remove-all').onclick=()=>remove(true);
 const originalStatus=editor.status.bind(editor);editor.status=()=>{originalStatus();markCurrent();};
 window.datasetTools={sync,markCurrent,select:(name,value)=>{value?selected.add(name):selected.delete(name);sync();},forget:name=>{selected.delete(name);sync();}};
 sync();
})();
