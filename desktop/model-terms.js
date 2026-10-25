/* Contextual Chinese explanations, checked against the installed Ultralytics
 * Conv/C2f/C3k2/C3k/Bottleneck/SPPF/C2PSA/PSABlock/Attention/Detect/DFL sources.
 * Source IDs remain unchanged; an unknown member never gets an invented role. */
((root)=>{
 const typeNames={Conv:'卷积模块',DWConv:'逐通道卷积模块',Conv2d:'二维卷积',BatchNorm2d:'批归一化',Bottleneck:'瓶颈特征块',C3k:'双分支特征块',PSABlock:'注意力特征块',SiLU:'SiLU 激活',Identity:'直接通过',MaxPool2d:'最大池化',Sequential:'顺序容器',ModuleList:'模块列表'};
 const pair=(label,detail)=>({label,detail});
 function member(parent,key,child={}){
  const type=parent?.type;
  if(['C2f','C3k2','C2PSA'].includes(type)){
   if(key==='cv1')return pair('入口卷积','先调整通道，再把特征分成两部分。');
   if(key==='cv2')return pair('融合输出卷积','把分支拼接后的特征融合为模块输出。');
   if(key==='m')return pair(type==='C2PSA'?'注意力块组':'内部特征块组',type==='C2PSA'?'依次处理其中一条分支；另一条分支保留后再拼接。':'依次提取其中一条分支的特征；cv1、cv2、m 是本模块的成员名。');
  }
  if(type==='A2C2f'){
   if(key==='cv1')return pair('入口卷积','调整通道，作为后续特征块的输入；这里不把入口特征分成两半。');
   if(key==='cv2')return pair('融合输出卷积','融合入口特征与各内部块输出的拼接结果。');
   if(key==='m')return pair('区域特征块组','按实际子模块处理特征，可能包含区域注意力块或 C3k。');
  }
  if(['C3','C3k'].includes(type)){
   const meanings={cv1:['主分支入口卷积','送入内部特征块组的分支。'],cv2:['旁路分支卷积','另一条分支，随后与主分支拼接。'],cv3:['融合输出卷积','融合主分支和旁路拼接后的特征。'],m:['内部特征块组','处理主分支特征。']};
   if(meanings[key])return pair(...meanings[key]);
  }
  if(type==='Bottleneck'&&['cv1','cv2'].includes(key))return pair(key==='cv1'?'内部卷积 1':'内部卷积 2',`瓶颈特征块的第 ${key==='cv1'?1:2} 个卷积模块。${parent.residual===true?'此块启用残差：卷积结果与块输入相加。':parent.residual===false?'此块未启用残差相加。':'残差开关未记录，请查看源码。'}`);
  if(type==='SPPF'){
   if(key==='cv1')return pair('池化前通道压缩','先压缩特征通道，再送入池化。');
   if(key==='cv2')return pair('多尺度融合卷积','融合原特征与连续池化结果拼接后的特征。');
   if(key==='m')return pair('共享最大池化',`同一个池化算子被连续调用 ${Number.isInteger(parent.pool_repeats)?parent.pool_repeats:'多'} 次，形成不同范围的特征；修改它会影响每次调用。`);
  }
  if(type==='Detect'){
   const meanings={one2one_cv2:['一对一位置回归分支','YOLO26 等端到端检测头的一对一匹配分支，用于边框预测。'],one2one_cv3:['一对一类别预测分支','端到端检测头的一对一匹配分支，用于类别预测。'],cv2:['位置回归分支','预测目标边框的位置分布；这里的 cv2 不是 C2f 的融合卷积。'],cv3:['类别预测分支','预测各类别的得分。'],dfl:['边框分布积分','把边框距离的离散分布转换为距离值。']};
   if(meanings[key])return pair(...meanings[key]);
  }
  if(type==='DFL'&&key==='conv')return pair('固定积分权重','用于分布加权求和的固定卷积，权重不参与训练，当前只读。');
  if(['Conv','DWConv'].includes(type)){
   const meanings={conv:['卷积核','提取局部特征；核大小决定覆盖范围。'],bn:['批归一化','BatchNorm：训练时使用批统计量，推理时通常使用保存的统计量。'],act:['激活函数','对卷积、归一化的结果施加激活运算；Identity 表示直接通过。']};
   if(meanings[key])return pair(...meanings[key]);
  }
  if(type==='ABlock'){if(key==='attn')return pair('区域注意力','在划分的区域中计算注意力关系。');if(key==='mlp')return pair('前馈变换','对区域注意力后的特征继续变换。');}
  if(type==='PSABlock'){
   if(key==='attn')return pair('自注意力','根据特征间的关系重新组合信息。');
   if(key==='ffn')return pair('前馈变换','在注意力处理之后继续变换特征。');
  }
  if(['Attention','AAttn'].includes(type)){
   const meanings={qkv:['查询、键、值投影','生成注意力所需的 query、key、value 特征。'],proj:['注意力输出投影','把注意力结果投影回输出特征。'],pe:['位置编码卷积','向注意力结果加入局部位置信息。']};
   if(meanings[key])return pair(...meanings[key]);
  }
  if(/^\d+$/.test(key)&&['ModuleList','Sequential'].includes(type)){
   const number=Number(key)+1;
   return pair(`第 ${number} 项 · ${typeNames[child.type]||child.type||'子模块'}`,`源码索引 ${key} 从 0 开始，因此对应第 ${number} 项。具体作用取决于外层分支；容器登记顺序不一定是完整计算顺序。`);
  }
  return pair(`源码成员 ${key}`,`类型：${child.type||'未记录'}。暂无可靠的专用作用说明，请结合所属模块 forward 源码查看。`);
 }
 function explain(layer,info){
  const parts=layer.id.split('.'),tree=new Map((info.module_tree||[]).map(row=>[row.id,row]));
  const topId=parts.slice(0,2).join('.'),top=tree.get(topId)||info.graph?.find(row=>row.id===topId);
  const steps=[{key:topId,label:`第 ${parts[1]} 层 · ${top?.type||'模块'}`,detail:'model 是整个网络，后面的编号从 0 开始，与左侧结构图一致。'}];
  for(let index=2;index<parts.length;index++){
   const parent=tree.get(parts.slice(0,index).join('.'))||(index===2?top:null),child=tree.get(parts.slice(0,index+1).join('.'))||{};
   steps.push({key:parts[index],...member(parent,parts[index],child)});
  }
  const label=steps.slice(1).map(step=>step.label).join(' › ')||steps[0].label;
  return {label,steps,id:layer.id};
 }
 // Group by real source ancestry. These are selection groups, never a new
 // execution graph: prediction scales use the recorded Detect input order.
 function navigation(node,info){
  const layers=(info.layers||[]).filter(l=>l.id===node.id||l.id.startsWith(node.id+'.'));
  const groups=new Map(),other=[];
  for(const layer of layers){
   const tail=layer.id.slice(node.id.length+1),head=node.type==='Detect'?tail.match(/^(one2one_)?cv([23])\.(\d+)\.(.+)$/):null;
   if(node.type==='Detect'&&!head){other.push(layer);continue;}
   const unit=layer.id.replace(/\.(conv|bn|act)$/,''),key=unit===node.id?node.id:unit;
   if(!groups.has(key)){
    const path=head?head[4].replace(/\.(conv|bn|act)$/,''):null;
    const meaning=explain(layer,info),parts=meaning.steps.slice(1,unit===layer.id?undefined:-1).filter(s=>!['内部特征块组','注意力块组'].includes(s.label));
    const label=head?path.split('.').map((s,i)=>/^\d+$/.test(s)?`${i?'子层':'处理层'} ${Number(s)+1}`:member((info.module_tree||[]).find(m=>m.id===key.slice(0,key.lastIndexOf('.'))),s).label).join(' · '):parts.map(s=>s.label).join(' / ')||'当前处理层';
    const scale=head?Number(head[3]):null,input=scale===null?null:node.execution?.input?.[scale];
    groups.set(key,{id:key,label,branch:head?(head[2]==='2'?'position':'category'):null,mode:head?(head[1]?'one2one':'regular'):null,scale,
     shape:Array.isArray(input)&&input.length===4&&input.every(Number.isInteger)?input.slice(2).join(' × '):null,layers:[]});
   }
   groups.get(key).layers.push(layer);
  }
  return {isHead:node.type==='Detect',groups:[...groups.values()],other};
 }
 const api={member,explain,navigation};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.ModelTerms=api;
})(typeof window==='undefined'?globalThis:window);
