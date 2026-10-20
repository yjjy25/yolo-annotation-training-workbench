/* Append data after project creation; originals and existing work stay intact. */
(() => {
 let paths=[],busy=false;
 const dialog=$('#import-data-dialog'),kind=()=>$('#import-data-kind').value;
 function lock(value){busy=value;for(const id of ['kind','path','choose','choose-all','submit','close'])$('#import-data-'+id).disabled=value;}
 $('#import-data').onclick=()=>{
  if(!state.project){toast('请先创建或打开项目，再导入数据。');return;}
  $('#import-data-status').textContent='导入的已有标注会设为待审核。';dialog.showModal();
 };
 $('#import-data-close').onclick=()=>dialog.close();
 dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 $('#import-data-kind').onchange=()=>{
  paths=[];$('#import-data-choose-all').hidden=!['tracking','frames'].includes(kind());$('#import-data-path').value='';$('#import-data-path').readOnly=kind()==='images';
  $('#import-data-path').placeholder=kind()==='folder'?'选择图片文件夹':kind()==='images'?'选择一张或多张图片':'选择视频文件';
 };
 async function choose(all=false){
  try{
   const video=['tracking','frames'].includes(kind());
   const chosen=await api.choose(all?'video-folder':kind()==='folder'?'source':kind()==='images'?'images':'videos');if(chosen===null)return;
   if(Array.isArray(chosen)&&!chosen.length){toast('所选文件夹中没有支持的视频。');return;}
   paths=Array.isArray(chosen)?chosen:[];$('#import-data-path').readOnly=paths.length>0;
   $('#import-data-path').value=paths.length?`已选择 ${paths.length} ${video?'个视频':'张图片'}：${paths.map(p=>p.split(/[\\/]/).pop()).join('、')}`:chosen;
  }catch(e){toast(e.message);}
 }
 $('#import-data-choose').onclick=()=>choose();
 $('#import-data-choose-all').onclick=()=>choose(true);
 $('#import-data-form').onsubmit=async event=>{
  event.preventDefault();if(busy)return;lock(true);
  try{
   await editor.save();
   const path=$('#import-data-path').value.trim();
   if(kind()==='tracking'){
    dialog.close();await go('video');window.setTrackingVideos(paths.length?paths:path);return;
   }
   if(kind()==='frames'){dialog.close();window.showVideoImport(paths.length?paths:path);return;}
   if(kind()==='images'&&!paths.length)throw new Error('请先选择图片文件。');
   $('#import-data-status').textContent='正在检查并导入图片副本…';
   const result=await rpc('import_images',kind()==='images'?{paths}:{path});
   await api.state().then(update);galleryKey='';paging.page=0;$('#image-filter').value='all';$('#image-search').value='';await loadImages();await go('data');dialog.close();
   toast(`已导入 ${result.count} 张图片${result.skipped?'，跳过 '+result.skipped+' 张已存在图片':''}${result.renamed?'，'+result.renamed+' 张已自动改名':''}。`);
  }catch(e){$('#import-data-status').textContent=e.message;}
  finally{lock(false);}
 };
})();
