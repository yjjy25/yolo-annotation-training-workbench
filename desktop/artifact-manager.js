/* Project-scoped, recoverable removal of models and validation runs. */
(() => {
 let root=null,models=[],validations=[],busy=false,generation=0;
 const selected={models:new Set(),validation:new Set()},dialog=$('#artifact-delete-dialog');
 function syncRoot(){if(root!==state.project?.root){root=state.project?.root;models=[];validations=[];selected.models.clear();selected.validation.clear();sync();}}
 function sync(){
  for(const button of document.querySelectorAll('.artifact-delete'))button.disabled=busy;
  for(const kind of ['models','validation'])for(const checkbox of document.querySelectorAll(`input[data-artifact-kind="${kind}"]`)){checkbox.checked=selected[kind].has(checkbox.dataset.artifactKey);checkbox.disabled=busy;}
  for(const [kind,list,id] of [['models',models,'model-manager-all'],['validation',validations,'validation-select-all']]){
   const n=list.filter(item=>selected[kind].has(item.key||item.id)).length,input=$('#'+id);
   input.checked=!!list.length&&n===list.length;input.indeterminate=n>0&&n<list.length;input.disabled=busy||!list.length;
  }
  $('#model-manager-count').textContent=`已选 ${selected.models.size} 个`;$('#validation-selected-count').textContent=`已选 ${selected.validation.size} 条`;
  $('#model-manager-delete').disabled=$('#trained-model-delete').disabled=busy||!selected.models.size;
  $('#validation-delete-selected').disabled=busy||!selected.validation.size;
 }
 function checkbox(kind,key,label){const input=document.createElement('input');input.type='checkbox';input.className='artifact-select';input.dataset.artifactKind=kind;input.dataset.artifactKey=key;input.checked=selected[kind].has(key);input.setAttribute('aria-label','选择 '+label);input.onchange=()=>{input.checked?selected[kind].add(key):selected[kind].delete(key);sync();};return input;}
 function deleteButton(kind,key){const button=document.createElement('button');button.type='button';button.className='artifact-delete';button.textContent='删除';button.onclick=()=>remove(kind,[key]);return button;}
 function decorateTrained(row,record){syncRoot();row.prepend(checkbox('models','runs/'+record.name+'/weights',record.name));row.append(deleteButton('models','runs/'+record.name+'/weights'));}
 function decorateValidation(row,record){syncRoot();row.prepend(checkbox('validation',record.id,record.at||record.id));row.append(deleteButton('validation',record.id));}
 function validationRecords(records){syncRoot();validations=records;const ids=new Set(records.map(r=>r.id));for(const id of selected.validation)if(!ids.has(id))selected.validation.delete(id);sync();}
 async function refresh(){
  syncRoot();const projectRoot=root,token=++generation,host=$('#model-manager-list');
  if(!projectRoot){host.replaceChildren();sync();return;}
  try{
   const records=await rpc('artifact_inventory',{kind:'models'});if(root!==projectRoot||state.project?.root!==projectRoot||token!==generation)return;
   models=records;const keys=new Set(records.map(r=>r.key));for(const key of selected.models)if(!keys.has(key))selected.models.delete(key);
   host.replaceChildren();
   if(!records.length){const p=document.createElement('p');p.className='muted';p.textContent='暂无本项目模型。训练完成后或将 PT 权重放入项目 models 文件夹后，可在这里管理。';host.append(p);}
   for(const item of records){const row=document.createElement('div');row.className='managed-model-row';const details=document.createElement('div'),name=document.createElement('strong'),path=document.createElement('small');name.textContent=item.label;path.textContent=item.path;details.title=item.detail;details.append(name,path);row.append(checkbox('models',item.key,item.label),details,deleteButton('models',item.key));host.append(row);}
   sync();
  }catch(error){toast(error.message);}
 }
 function cleanOptions(removed){
  const normal=p=>p.replaceAll('\\','/').toLowerCase();
  for(const id of ['train-model','predict-model','validate-model','export-model'])for(const option of [...$('#'+id).options])if(removed.some(item=>normal(option.value)===normal(item.path)||normal(option.value).startsWith(normal(item.path)+'/')))option.remove();
 }
 async function remove(kind,keys=[...selected[kind]]){
  if(busy||!keys.length)return;syncRoot();const projectRoot=root;
  try{
   const records=await rpc('artifact_inventory',{kind});if(projectRoot!==state.project?.root)return;
   const targets=records.filter(r=>keys.includes(r.key));if(targets.length!==new Set(keys).size){toast('列表已变化，请刷新后重新选择。');return;}
   $('#artifact-delete-title').textContent=kind==='models'?`删除 ${targets.length} 个模型？`:`删除 ${targets.length} 条验证结果？`;
   $('#artifact-delete-detail').textContent=kind==='models'?'移出所选模型权重（训练模型含 best.pt / last.pt），保留训练曲线、日志及验证结果。':'移出所选验证记录及对应指标、结果图和结果视频，模型与数据集保留。';
   $('#artifact-delete-list').textContent=targets.map(item=>item.path).join('\n');dialog.returnValue='';dialog.showModal();
   const accepted=await new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='delete'),{once:true}));if(!accepted||projectRoot!==state.project?.root)return;
   busy=true;sync();if(kind==='validation')clearValidationVideo();
   const result=await rpc('archive_artifacts',{kind,keys,project_root:projectRoot});if(projectRoot!==state.project?.root)return;
   for(const key of result.keys)selected[kind].delete(key);
   if(kind==='models'){cleanOptions(targets.filter(item=>result.keys.includes(item.key)));modelKey='';await refreshModels();await refresh();}
   else{state.validationMetrics=null;state.validationInfo={status:'idle',logs:[]};await refreshValidationPlots();const latest=(await api.validationHistory())[0];state.validationMetrics=latest?.metrics||null;renderValidation(state.validationInfo,state.project);}
   toast(`已删除 ${result.count} ${kind==='models'?'个模型':'条验证结果'}，可在“数据与标注 → 回收站”恢复。`+(result.failed.length?` ${result.failed.length} 项未成功，请刷新后重试。`:''));
  }catch(error){toast(error.message);}
  finally{busy=false;sync();}
 }
 $('#model-manager-jump').onclick=()=>$('.model-manager').scrollIntoView({block:'start',behavior:'smooth'});
 $('#model-manager-refresh').onclick=refresh;
 $('#model-manager-all').onchange=e=>{for(const item of models)e.target.checked?selected.models.add(item.key):selected.models.delete(item.key);sync();};
 $('#validation-select-all').onchange=e=>{for(const item of validations)e.target.checked?selected.validation.add(item.id):selected.validation.delete(item.id);sync();};
 $('#model-manager-delete').onclick=$('#trained-model-delete').onclick=()=>remove('models');$('#validation-delete-selected').onclick=()=>remove('validation');
 window.artifactManager={syncRoot,refreshModels:refresh,decorateTrained,decorateValidation,validationRecords};syncRoot();
 modelKey='';refreshModels().then(refresh).catch(error=>toast(error.message));
})();
