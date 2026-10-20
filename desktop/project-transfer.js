/* Portable project transfer through a verified package or copied folder. */
(() => {
 let mode='import',busy=false;
 const dialog=$('#project-transfer-dialog');
 const options=()=>Object.fromEntries(['results','sources','snapshots','recycle'].map(key=>['include_'+key,$('#project-transfer-'+key).checked]));
 function sync(){
  for(const control of dialog.querySelectorAll('input,button,select'))control.disabled=busy;
  $('#project-transfer-submit').textContent=busy?'正在处理，请勿关闭软件…':mode==='import'?'导入项目':'导出项目';
  $('#project-transfer-options').hidden=mode==='import'&&$('#project-transfer-kind').value==='project-package';
 }
 async function open(next){
  if(busy)return;if(next==='export'&&!state.project){toast('请先打开项目。');return;}mode=next;
  $('#project-transfer-title').textContent=next==='import'?'导入项目':'导出项目';$('#project-transfer-import-fields').hidden=next!=='import';$('#project-transfer-export-fields').hidden=next!=='export';
  $('#project-transfer-status').textContent=next==='import'?'接收方选择项目包，导入后即可继续标注和训练。':'导出为 ZIP 后发送给另一位用户，在同一软件中导入。大项目需要较长时间。';
  if(!$('#project-transfer-target').value){const defaults=await api.defaults();$('#project-transfer-target').value=defaults.projects+'/导入的项目';}sync();dialog.showModal();
 }
 $('#project-import-open').onclick=()=>open('import').catch(e=>toast(e.message));$('#project-export-open').onclick=()=>open('export').catch(e=>toast(e.message));
 $('#project-transfer-close').onclick=()=>dialog.close();dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 $('#project-transfer-kind').onchange=()=>{$('#project-transfer-source').value='';sync();};
 $('#project-transfer-choose-source').onclick=async()=>{try{const file=await api.choose($('#project-transfer-kind').value);if(file)$('#project-transfer-source').value=file;}catch(e){toast(e.message);}};
 $('#project-transfer-choose-parent').onclick=async()=>{try{const folder=await api.choose('root');if(folder)$('#project-transfer-target').value=folder+'/导入的项目';}catch(e){toast(e.message);}};
 $('#project-transfer-choose-package').onclick=async()=>{try{const file=await api.choose('project-export');if(file)$('#project-transfer-package').value=file;}catch(e){toast(e.message);}};
 $('#project-transfer-form').onsubmit=async e=>{
  e.preventDefault();if(busy)return;
  const args=mode==='export'?{target:$('#project-transfer-package').value.trim(),options:options()}:{source:$('#project-transfer-source').value.trim(),target:$('#project-transfer-target').value.trim(),options:options()};
  if(!args.target||(mode==='import'&&!args.source)){$('#project-transfer-status').textContent='请先选择完整的来源和保存位置。';return;}
  busy=true;sync();$('#project-transfer-status').textContent='正在复制并校验文件；项目较大时请耐心等待，不要关闭软件。';
  try{
   await editor.save();const result=await rpc(mode+'_project',args);
   if(mode==='import'){await api.state().then(update);await go('data');galleryKey='';await loadImages();}
   $('#project-transfer-status').textContent=`${mode==='import'?'已导入':'已导出'} ${result.files} 个文件，${projectStorage.format(result.bytes)}。保存到：${result.root||result.path}`+(result.missing_sources?.length?` 有 ${result.missing_sources.length} 个原始视频不在来源位置，未能携带；已抽取的图片与标注仍可使用。`:'');
   toast(mode==='import'?'项目已导入并打开。':'项目包已导出。');
  }catch(error){$('#project-transfer-status').textContent=error.message;}finally{busy=false;sync();}
 };
})();
