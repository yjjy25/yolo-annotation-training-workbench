/* Fixed-topology editor. The backend owns construction, validation and provenance. */
(()=>{
 const el=id=>document.getElementById('design-'+id);
 let report=null,previousReport=null,checked=null,owner=null,busy=false,generation=0,measurementReady=false,autoTimer=null,modelSession=false;
 const cancelAuto=()=>{clearTimeout(autoTimer);autoTimer=null;};
 function invalidateMeasurement(message){measurementReady=false;clearCheck();el('graph').parentElement.setAttribute('aria-busy','true');el('block-info').textContent=message;el('params').textContent=message;el('navigation').disabled=true;el('readonly-operators').querySelectorAll('button').forEach(button=>button.disabled=true);el('apply').disabled=true;status(message);}
 const edits=new Map(),history=[];
 const status=text=>{el('status').textContent=text;};
 function options(select,entries){select.replaceChildren();for(const [value,label] of entries){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}}
 let templateCatalog=null,catalogLoading=null;
 function chooseTemplate(id){
  const family=templateCatalog.families.find(f=>f.variants.some(v=>v.id===id));if(!family)throw Error('该模型不在当前支持目录中，请选择已验证模板。');
  el('family').value=family.id;options(el('template'),family.variants.map(v=>[v.id,v.label]));
  if(family.variants.some(v=>v.id===id))el('template').value=id;
 }
 async function ensureCatalog(){
  if(templateCatalog)return;
  if(!catalogLoading)catalogLoading=rpc('model_design_catalog').then(data=>{
   const previous=el('template').value;templateCatalog=data;
   options(el('family'),data.families.map(f=>[f.id,f.label]));chooseTemplate(previous);
   for(const key of ['min','max','step'])el('size')[key]=data.input[key];
   el('size-presets').replaceChildren();for(const value of data.input.presets){const option=document.createElement('option');option.value=value;el('size-presets').append(option);}
  }).catch(error=>{catalogLoading=null;throw error;});
  await catalogLoading;
 }
 function clearCheck(){checked=null;el('train').disabled=true;el('revision').textContent='尚未保存检查通过的修订';}
 function currentProject(){return state.project?.root;}
 function reset(){if(owner!==currentProject())modelSession=false;cancelAuto();measurementReady=false;previousReport=null;report=null;owner=currentProject();edits.clear();history.length=0;clearCheck();el('graph').replaceChildren();graphView.selected=-1;graphView.plan=null;graphView.zoom=1;el('graph').parentElement.scrollTo(0,0);el('selection').textContent='加载结构后，点击模块查看输入与流向。';el('stages').replaceChildren();el('layers').replaceChildren();el('operators').replaceChildren();for(const id of ['branches','scales','groups','readonly-operators'])el(id).replaceChildren();for(const id of ['head-guide','head-branches','head-modes','head-scales'])el(id).hidden=true;el('navigation').disabled=true;el('module-intro').textContent='先加载模型，再从左侧选择一个模块。';el('operator-purpose').textContent='不确定怎么改时，可以保持原值，先了解它的作用。';el('edit-help').textContent='选择上方内容后，这里会显示当前值和修改说明。';el('module-title').closest('.design-inspector').classList.remove('is-detection');el('module-title').textContent='选择一个模块';el('params').textContent='';el('block-info').textContent='';el('block-source').textContent='';el('pending').textContent='选择算子后修改参数。';el('apply').disabled=true;el('initialize').disabled=true;el('value').disabled=true;el('operator-name').textContent='选择算子查看中文说明';el('operator-id').textContent='';el('path-meaning').replaceChildren();el('source').textContent='选择算子查看真实实现与来源哈希。';el('diff').textContent='暂无修改。';}
 function params(){return {action:'inspect',template:el('template').value,imgsz:Number(el('size').value),seed:Number(el('seed').value),edits:[...edits.values()]};}
 async function job(action){
  if(busy)return;cancelAuto();
  try{await ensureCatalog();}catch(error){toast(error.message);return;}if(busy)return;
  if(!state.project||state.project.task!=='detect'){toast('请先打开目标检测项目。');return;}
  if(owner!==currentProject())reset();
  const token=++generation,project=currentProject();busy=true;invalidateMeasurement('正在自动前向检测输入、输出，请稍候…');
  el('inspect').disabled=el('check').disabled=true;el('stop').disabled=false;
  for(const id of ['family','template','size','seed','apply','layers','value','initialize'])el(id).disabled=true;
  el('operators').querySelectorAll('button').forEach(button=>button.disabled=true);
  status(action==='inspect'?'正在独立进程构建结构…':'正在检查前向、损失和反向；通过后保存修订…');
  try{
   await rpc('model_design_start',{...params(),action});
   while(token===generation&&project===currentProject()){
    const result=await rpc('model_design_status');
    if(token!==generation||project!==currentProject())return;
    if(result.status==='completed'){
     previousReport=report;report=result.result;measurementReady=true;modelSession=true;render();
     if(action==='check'){
      checked=report;el('train').disabled=false;
      el('revision').textContent=`${report.revision}\n结构身份：${report.design_hash}\n配置 SHA256：${report.model_sha256}\n保存：${report.model_path}`;
     }
     status(action==='check'?'检查通过并已保存；仅证明此尺寸的合成训练计算可运行，尚无精度结论。':'已加载真实结构；选择算子修改参数。');
     return;
    }
    if(result.status!=='running')throw Error(result.error||'检查未产生结果。');
    await new Promise(resolve=>setTimeout(resolve,500));
   }
  }catch(error){status(error.message);toast(error.message);}
  finally{busy=false;el('graph').parentElement.setAttribute('aria-busy','false');el('initialize').disabled=!report||!edits.size;el('inspect').disabled=el('check').disabled=false;el('stop').disabled=true;for(const id of ['family','template','size','seed','layers'])el(id).disabled=false;inspect();}
 }
 function render(){
  const selected=el('layers').value;
  selectLayer(report.modified.layers.find(l=>l.id===selected)||report.modified.layers[0]);
  const rows=report.design.edits.map(edit=>{
   const original=report.baseline.layers.find(l=>l.id===edit.id);
   const before=edit.field==='activation'?original?.params.activation:original?.params.kernel;
   return `${edit.id}：${JSON.stringify(before)} → ${JSON.stringify(edit.value)} (${edit.field})`;
  });
  el('diff').textContent=`基线参数：${report.baseline.parameters.toLocaleString()}\n修改后参数：${report.modified.parameters.toLocaleString()}\n参数差值：${report.parameter_delta>=0?'+':''}${report.parameter_delta}\n${report.initialization}\n${rows.join('\n')||'结构未修改，适合作为编辑器无修改对照。'}`;
  draw();inspect();el('initialize').disabled=busy||!edits.size;
 }
 const graphView=new ModelGraph.View(el('graph'),node=>{
  const layer=report.modified.layers.find(l=>l.id.startsWith(node.id+'.')&&l.editable)||report.modified.layers.find(l=>l.id===node.id||l.id.startsWith(node.id+'.'));
  if(layer){selectLayer(layer);inspect();el('layers').closest('.design-inspector-body').scrollTop=0;}
 });
 function selectLayer(layer){
  if(!layer)return;
  const parent=layer.id.match(/^model\.\d+/)?.[0];
  const layers=report.modified.layers.filter(l=>l.id===parent||l.id.startsWith(parent+'.'));
  options(el('layers'),layers.map(l=>[l.id,`${ModelTerms.explain(l,report.modified).label} · ${l.editable?'可修改':'只读'}〔${l.id}〕`]));
  el('layers').value=layer.id;
 }
 function operatorButtons(layer){
  const parent=layer.id.match(/^model\.(\d+)/),node=report.modified.graph[Number(parent?.[1])];
  const titles={Detect:'检测头 · 给出最后的预测',Conv:'卷积模块 · 提取局部特征',C2f:'特征提取 · 组合图片信息',C3k2:'特征提取 · 组合图片信息',SPPF:'多尺度池化 · 汇总周围信息',C2PSA:'注意力模块 · 关联不同位置',Concat:'特征拼接 · 汇合多路信息',Upsample:'上采样 · 放大特征图'};
  el('module-title').closest('.design-inspector').classList.toggle('is-detection',node?.type==='Detect');
  el('module-title').textContent=titles[node?.type]||`第 ${parent?.[1]} 层 · ${node?.type||layer.type}`;
  el('module-intro').textContent=node?.type==='Detect'?'把前面的图片特征变成两种预测：目标的边框位置，以及它属于哪个类别。':'先选择内部处理层，再查看它能调整的内容。不确定如何修改时，可以保留当前值。';
  const execution=node?.execution;
  const info=[];
  if(report.measurement){const time=new Date(report.measurement.measured_at).toLocaleTimeString('zh-CN',{hour12:false});info.push(`自动实测已更新：${time} · ${report.measurement.id.slice(0,8)}`);}
  if(execution){info.push(`输入：${JSON.stringify(execution.input)}`,`输出：${JSON.stringify(execution.output)}`,`实测模式：eval，NCHW = [批量, 通道, 高, 宽]`,`逐输入张量核对连线：${execution.connections_verified?'通过':'未通过'}`);}
  else info.push('此历史修订没有模块级实测数据，请重新加载或检查。');
  if(previousReport){const prior=previousReport.modified.graph.find(n=>n.id===node?.id)?.execution;if(prior&&execution){const same=JSON.stringify(prior.input)===JSON.stringify(execution.input)&&JSON.stringify(prior.output)===JSON.stringify(execution.output);info.push(same?'本次重新检测后尺寸未变。激活保持形状；修改核大小时同步调整填充。':`尺寸已变化。上次输入：${JSON.stringify(prior.input)}；上次输出：${JSON.stringify(prior.output)}`);}}
  const liveConv=report.modified.layers.find(l=>l.id===node?.id+'.conv');if(liveConv)info.push(`当前卷积：核 ${JSON.stringify(liveConv.params.kernel)}；填充 ${JSON.stringify(liveConv.params.padding)}；步长 ${JSON.stringify(liveConv.params.stride)}；通道 ${liveConv.params.in_channels} → ${liveConv.params.out_channels}`);
  const upstream=report.design.source.upstream;if(upstream)info.push(`官方依据：${upstream.tag} · ${upstream.commit.slice(0,12)}`);
  if(node?.definition)info.push('原始模板行（修改前）：'+JSON.stringify(node.definition));
  info.push('当前显示 YAML 顶层模块；模块内部的分支、拼接、残差不在左图展开。');
  if(node?.children?.length)info.push('注册子模块（不等同执行顺序）：'+node.children.map(c=>`${ModelTerms.member(report.modified.module_tree?.find(m=>m.id===node.id)||node,c.name,c).label}（${c.name}: ${c.type}）`).join('；'));
  if(node?.type==='Detect'&&report.execution){info.push(`检测分支步长：${report.execution.detection_strides.join(' / ')}；多个尺度由同一 Detect 模块处理。`);const head=report.modified.detection;if(head)info.push(`检测头：reg_max=${head.reg_max}；DFL=${head.dfl}；一对一分支=${head.one2one?'具备':'无'}；当前推理=${head.end2end?'一对一':'一对多'}`);}
  el('block-info').textContent=info.join('\n');
  el('block-source').textContent=JSON.stringify(node?.source||{},null,2)+'\n\n'+(report.source_code?.[node?.source?.class]||'此修订未保存模块源码，请重新加载。');
  renderNavigation(node||{id:layer.id.match(/^model\.\d+/)[0],type:layer.type},layer);
 }
 function renderNavigation(node,layer){
  const nav=ModelTerms.navigation(node,report.modified),groups=nav.groups;
  const active=groups.find(g=>g.layers.some(l=>l.id===layer.id))||groups.find(g=>g.layers.some(l=>l.editable))||groups[0];
  const focused=el('navigation').contains(document.activeElement)?document.activeElement.dataset.navKey:null;
  const choose=items=>{const next=items.find(l=>layer.editable?l.editable===layer.editable:l.type===layer.type)||items.find(l=>l.editable)||items[0];if(next){el('layers').value=next.id;inspect();}};
  const choice=(target,key,title,note,selected,action)=>{
   const button=document.createElement('button'),strong=document.createElement('strong');button.type='button';button.dataset.navKey=key;strong.textContent=title;button.append(strong);
   button.disabled=busy||!measurementReady;
   if(note){const small=document.createElement('small');small.textContent=note;button.append(small);}
   button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));button.onclick=action;el(target).append(button);return button;
  };
  for(const id of ['branches','scales','groups','operators','readonly-operators'])el(id).replaceChildren();
  el('navigation').disabled=busy||!measurementReady;
  el('head-guide').hidden=true;el('head-branches').hidden=!nav.isHead||!groups.length;el('head-scales').hidden=!nav.isHead||!groups.length;
  el('head-modes').hidden=true;el('group-section').hidden=groups.length<=1;
  el('group-step').textContent=nav.isHead?'3':'1';el('parameter-step').textContent=nav.isHead?'4':groups.length>1?'2':'1';
  if(nav.isHead&&active){
   for(const [id,title,note]of [['position','框在哪里','预测边框的位置和大小'],['category','是什么目标','预测各个类别的得分']]){
    const matches=groups.filter(g=>g.branch===id);if(!matches.length)continue;
    choice('branches','branch-'+id,title,note,active.branch===id,()=>choose((matches.find(g=>g.mode===active.mode&&g.scale===active.scale)||matches[0]).layers));
   }
   el('branch-hint').textContent=active.branch==='position'?'当前查看：位置预测。这里的修改只作用于边框预测分支。':'当前查看：类别判断。这里的修改只作用于类别得分预测分支。';
   const branch=groups.filter(g=>g.branch===active.branch),modes=[...new Set(branch.map(g=>g.mode))];
   el('head-modes').hidden=modes.length<2;
   options(el('head-mode'),modes.map(m=>[m,m==='one2one'?'一对一分支':'常规分支（一对多）']));el('head-mode').value=active.mode;
   const inference=report.modified.detection?.inference_branch;
   el('mode-hint').textContent=inference?`此模型含两组预测分支；当前推理使用${inference==='one2one'?'一对一':'常规（一对多）'}分支。修改只作用于所选分支组。`:'此模型含两组预测分支，当前修订未记录推理使用哪一组。';
   el('head-mode').onchange=()=>{const matches=branch.filter(g=>g.mode===el('head-mode').value);choose((matches.find(g=>g.scale===active.scale)||matches[0]).layers);};
   const scales=[...new Set(branch.filter(g=>g.mode===active.mode).map(g=>g.scale))];
   for(const scale of scales){
    const matches=branch.filter(g=>g.mode===active.mode&&g.scale===scale),shape=matches[0].shape;
    choice('scales','scale-'+scale,`输入 ${scale+1}`,shape?`${shape} 网格`:'尺寸待重新实测',active.scale===scale,()=>choose(matches[0].layers));
   }
  }
  const visible=nav.isHead?groups.filter(g=>g.branch===active?.branch&&g.mode===active?.mode&&g.scale===active?.scale):groups;
  for(const group of visible)choice('groups','group-'+group.id,group.label,'',group.id===active?.id,()=>choose(group.layers));
  const items=active?.layers||[],editable=items.filter(l=>l.editable),readonly=items.filter(l=>!l.editable).concat(nav.other);
  for(const item of editable){
   const title=item.editable==='activation'?'响应方式 · 激活函数':item.editable==='pool_kernel'?'汇总范围 · 池化核':'卷积范围 · 卷积核';
   const value=item.editable==='activation'?item.params.activation:Array.isArray(item.params.kernel)?item.params.kernel.join(' × '):`${item.params.kernel} × ${item.params.kernel}`;
   choice('operators','operator-'+item.id,title,value,item.id===layer.id,()=>choose([item]));
  }
  for(const item of readonly){const meaning=ModelTerms.explain(item,report.modified);choice('readonly-operators','operator-'+item.id,meaning.steps.at(-1).label,'只读',item.id===layer.id,()=>choose([item]));}
  el('readonly-note').hidden=editable.length>0;el('readonly-details').hidden=!readonly.length;
  if(!layer.editable)el('readonly-details').open=true;
  else el('readonly-details').open=false;
  if(focused)el('navigation').querySelectorAll('[data-nav-key]').forEach(b=>{if(b.dataset.navKey===focused)b.focus({preventScroll:true});});
 }
 function pending(){
  const layer=report?.modified.layers.find(l=>l.id===el('layers').value);if(!layer)return;
  const before=layer.editable==='activation'?layer.params.activation:Array.isArray(layer.params.kernel)?layer.params.kernel[0]:layer.params.kernel;
  const value=el('value').value,changed=String(before)!==value;
  el('pending').textContent=!layer.editable?'此算子仅供观察。':changed?`待应用：${before} → ${value}${layer.editable==='activation'?'':'（核大小）'}`:'参数与当前结构一致。';
  el('apply').disabled=busy||!measurementReady||!layer.editable||!changed;
  if(changed&&layer.editable&&el('auto-measure').checked)el('pending').textContent+='；稍后自动应用并实测。';
 }
 function draw(){if(report)graphView.render(report.modified.graph,report.modified.layers,edits.keys(),report.design);}
 function inspect(){
  cancelAuto();
  if(!report)return;if(!measurementReady)return;const layer=report.modified.layers.find(l=>l.id===el('layers').value);if(!layer)return;operatorButtons(layer);
  const meaning=ModelTerms.explain(layer,report.modified);el('operator-name').textContent=layer.editable==='activation'?'响应方式：决定特征值怎样通过':layer.editable==='pool_kernel'?'汇总范围：一次汇总多大的区域':layer.editable?'卷积范围：一次查看多大的区域':meaning.steps.at(-1).label+' · 只读';el('operator-id').textContent=layer.id+' · '+layer.type;el('path-meaning').replaceChildren();
  el('operator-purpose').textContent=layer.editable==='activation'?'激活函数变换特征值，帮助模型表达复杂关系。这里只调整当前一处。':layer.editable==='pool_kernel'?'池化把周围特征汇总到一起。范围越大，汇总的邻近位置越多。':layer.editable?'卷积核像一个小窗口。3 × 3 表示每次覆盖高、宽各 3 个特征位置。':meaning.steps.at(-1).detail;
  for(const step of meaning.steps){const li=document.createElement('li'),name=document.createElement('strong'),detail=document.createElement('span');name.textContent=step.key+'：'+step.label;detail.textContent=step.detail;li.append(name,detail);el('path-meaning').append(li);}
  const parent=layer.id.match(/^model\.(\d+)/);if(parent)graphView.select(Number(parent[1]));
  const labels={kernel:layer.editable==='pool_kernel'?'池化核大小':'卷积核大小',in_channels:'输入通道数',out_channels:'输出通道数',stride:'步长',groups:'卷积分组数',padding:'边缘填充',activation:'激活函数'};
  const format=value=>Array.isArray(value)?value.map(format).join(' × '):String(value);
  const lines=Object.entries(layer.params).map(([key,value])=>`${labels[key]||key}：${format(value)}`);
  const shapes=report.shapes?.[layer.id];
  if(shapes?.input&&shapes?.output)lines.push('',`算子实测输入：${JSON.stringify(shapes.input)}`,`算子实测输出：${JSON.stringify(shapes.output)}`);
  else if(shapes?.shared_calls_ref)lines.push('',`共享算子，多次调用记录见 ${shapes.shared_calls_ref}`);
  else if(shapes?.calls)lines.push('',`共享实例，实际调用 ${shapes.calls.length} 次；各次尺寸保存在检查报告中。`);
  else lines.push('','此历史修订缺少算子实测尺寸，请点击加载结构自动重测。');
  if(!Object.keys(layer.params).length)lines.unshift('此算子暂无开放的结构参数，可查看其实现来源。');
  if(layer.type==='Conv2d')lines.push('','核大小决定单次卷积覆盖的区域；通道数表示输入、输出特征的数量。');
  el('params').textContent=lines.join('\n');
  el('source').textContent=JSON.stringify(layer.source,null,2)+'\n\n'+(report.source_code?.[layer.source.class]||'');
  el('field').textContent=layer.editable==='activation'?'激活函数':layer.editable==='pool_kernel'?'池化核大小':layer.editable?'核大小':'此算子只读';
  options(el('value'),layer.editable==='activation'?[['SiLU','SiLU · 平滑调节'],['ReLU','ReLU · 负值归零'],['LeakyReLU','LeakyReLU · 保留少量负值'],['GELU','GELU · 平滑调节'],['Identity','Identity · 直接通过']]:[1,3,5,7].map(x=>[x,x+' × '+x]));
  el('edit-help').textContent=!layer.editable?'这是只读组件。请在上方选择“卷积范围”或“响应方式”进行修改。':layer.editable==='activation'?'切换这里只改变当前一处的响应方式，不改变特征图尺寸。不同函数的识别效果需要训练后比较。':layer.editable==='pool_kernel'?'修改周围信息的汇总范围；共享池化会影响它的每次调用。工具会保持输出尺寸。':'范围越大，计算量通常越多。工具会保持输出尺寸；识别效果需训练后比较。';
  const value=layer.editable==='activation'?layer.params.activation:Array.isArray(layer.params.kernel)?layer.params.kernel[0]:layer.params.kernel;
  el('value').value=String(value);el('value').disabled=!layer.editable||busy;pending();
 }
 el('zoom').onchange=()=>el('zoom').value==='fit'?graphView.fit():graphView.setZoom(Number(el('zoom').value)/100);
 el('zoom-in').onclick=()=>graphView.setZoom(graphView.zoom+.25);
 el('zoom-out').onclick=()=>graphView.setZoom(graphView.zoom-.25);
 el('all-paths').onclick=()=>graphView.select(-1);
 function expandEditor(expanded){const panel=el('graph').closest('.design-grid');panel.classList.toggle('design-expanded',expanded);el('fullscreen').textContent=expanded?'收起编辑区':'全屏编辑';el('fullscreen').setAttribute('aria-pressed',String(expanded));}
 el('fullscreen').onclick=()=>expandEditor(!el('graph').closest('.design-grid').classList.contains('design-expanded'));
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]'))expandEditor(false);});
 api.onState(()=>{if(document.getElementById('page-design').hidden)expandEditor(false);});
 el('inspect').onclick=()=>job('inspect');el('check').onclick=()=>job('check');el('layers').onchange=inspect;el('value').onchange=()=>{cancelAuto();pending();if(!el('auto-measure').checked||el('apply').disabled)return;const id=el('layers').value,value=el('value').value,project=currentProject();autoTimer=setTimeout(()=>{if(!busy&&currentProject()===project&&el('layers').value===id&&el('value').value===value)el('apply').click();},650);};
 el('auto-measure').onchange=()=>{cancelAuto();if(report&&!measurementReady&&el('auto-measure').checked)inputConfiguration();else pending();};
 function capturePendingEdit(){
  if(!measurementReady)return false;
  const layer=report?.modified.layers.find(l=>l.id===el('layers').value);if(!layer?.editable)return false;
  const value=layer.editable==='activation'?el('value').value:Number(el('value').value),current=layer.editable==='activation'?layer.params.activation:Array.isArray(layer.params.kernel)?layer.params.kernel[0]:layer.params.kernel;
  if(value===current)return false;
  history.push([...edits.entries()]);const original=report.baseline.layers.find(l=>l.id===layer.id),base=layer.editable==='activation'?original.params.activation:Array.isArray(original.params.kernel)?original.params.kernel[0]:original.params.kernel;
  if(value===base)edits.delete(layer.id);else edits.set(layer.id,{id:layer.id,field:layer.editable,value});return true;
 }
 el('apply').onclick=async()=>{
  cancelAuto();if(busy||!capturePendingEdit())return;clearCheck();await job('inspect');
 };
 el('initialize').onclick=async()=>{
  if(busy||!report||!edits.size)return;
  history.push([...edits.entries()]);edits.clear();clearCheck();await job('inspect');
 };
 el('undo').onclick=async()=>{if(busy||!history.length)return;const previous=history.pop();edits.clear();for(const [k,v] of previous)edits.set(k,v);clearCheck();await job('inspect');};
 el('family').onchange=()=>{if(busy||!templateCatalog)return;const family=templateCatalog.families.find(f=>f.id===el('family').value),oldScale=templateCatalog.families.flatMap(f=>f.variants).find(v=>v.id===el('template').value)?.scale;const loaded=modelSession;chooseTemplate((family.variants.find(v=>v.scale===oldScale)||family.variants[0]).id);reset();status('模型家族已改变，请重新加载结构。');if(loaded&&el('auto-measure').checked)autoTimer=setTimeout(()=>job('inspect'),650);};
 el('template').onchange=()=>{if(busy)return;const loaded=modelSession;reset();status('配置已改变，请重新加载结构。');if(loaded&&el('auto-measure').checked)autoTimer=setTimeout(()=>job('inspect'),650);};
 function inputConfiguration(){
  if(busy)return;cancelAuto();capturePendingEdit();const size=Number(el('size').value),seed=Number(el('seed').value),range=templateCatalog?.input||{min:64,max:1280,step:32};
  const valid=Number.isInteger(size)&&size>=range.min&&size<=range.max&&size%range.step===0&&Number.isInteger(seed)&&seed>=0&&seed<2147483648;
  if(!report){status(valid?'点击加载结构即可实测输入、输出。':`尺寸须为 ${range.min}～${range.max} 内 ${range.step} 的倍数，种子须为非负整数。`);if(valid&&modelSession&&el('auto-measure').checked)autoTimer=setTimeout(()=>job('inspect'),650);return;}
  invalidateMeasurement(valid?'配置已改变，等待自动实测；已有结构修改会保留。':`输入无效：尺寸须为 ${range.min}～${range.max} 内 ${range.step} 的倍数，种子须为非负整数。`);
  if(valid&&el('auto-measure').checked)autoTimer=setTimeout(()=>job('inspect'),650);
 }
 for(const id of ['size','seed']){el(id).oninput=inputConfiguration;el(id).onchange=inputConfiguration;}

 el('stop').onclick=async()=>{++generation;await rpc('model_design_stop');status('检查已停止；未通过的修改不可用于训练。');};
 el('train').onclick=async()=>{
  if(!checked||owner!==currentProject())return;
  const artifact=checked;await go('train');
  if(owner!==currentProject())return;
  const select=document.getElementById('train-model'),option=document.createElement('option');
  option.value=artifact.model_path;option.textContent=`结构设计 ${artifact.revision}（从零训练）`;select.append(option);select.value=option.value;
  document.getElementById('train-imgsz').value=artifact.design.imgsz;
  toast('已选择检查通过的结构；确认数据划分和训练参数后开始训练。');
 };
 el('refresh').onclick=async()=>{try{const revisions=await rpc('model_design_revisions');options(el('history'),revisions.map(r=>[r.id,r.id]));}catch(error){toast(error.message);}};
 el('load').onclick=async()=>{if(busy||!el('history').value)return;try{await ensureCatalog();const project=currentProject(),saved=await rpc('model_design_read',{revision:el('history').value});if(project!==currentProject())return;reset();report=saved;measurementReady=true;modelSession=true;for(const edit of saved.design.edits)edits.set(edit.id,edit);chooseTemplate(saved.design.template);el('size').value=saved.design.imgsz;el('seed').value=saved.design.seed;render();checked=saved;el('train').disabled=false;el('revision').textContent=saved.revision+'\n'+saved.model_path;status('已载入历史修订。训练前将重新核对来源、类别与尺寸；也可重新检查保存新版本。');if(!saved.measurement){invalidateMeasurement('历史修订缺少自动实测数据，正在重测；原修订保留。');autoTimer=setTimeout(()=>job('inspect'),650);}}catch(error){toast(error.message);}};
 api.onState(()=>{if(state.project&&!templateCatalog)ensureCatalog().catch(error=>status(error.message));if(owner&&owner!==currentProject()){++generation;reset();}});
})();
