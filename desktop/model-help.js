/* Parameter explanations based on the installed torch.nn docstrings and the
 * workbench's explicit construction rules. Rendering uses text nodes only. */
(()=>{
 const el=id=>document.getElementById('design-'+id);
 const topics={
  kernel:{title:'卷积核大小怎么选？',intro:'卷积核决定一次卷积在特征图上覆盖多大的局部区域。3×3 表示高和宽各覆盖 3 个位置，不表示输入或输出通道数。',rows:[['1×1','主要混合通道信息；单次不覆盖相邻空间位置。'],['3×3','覆盖邻近区域，适合作为当前结构的对照起点。'],['5×5 / 7×7','覆盖更大区域；在通道数、分组不变时，参数量和计算量通常增加。']],notes:['当前工具会配合核大小调整 padding，保持这个算子的输出空间尺寸；不会自动增加检测尺度。','3×3 改成 5×5 时，该卷积层重新随机初始化，需重新检查并训练。核更大不保证小目标效果更好。']},
  pool_kernel:{title:'池化核大小是什么意思？',intro:'池化把邻域内的特征汇总。最大池化取区域中的最大值；它本身没有可训练的卷积权重。',rows:[['核大小','决定每次汇总的空间范围。'],['步长 stride','决定窗口移动距离，影响输出尺寸。当前只开放步长为 1、可保持空间尺寸的池化核。'],['SPPF 的 m','同一个池化算子被连续调用，修改核大小会影响它的每次调用。']],notes:['更大的池化范围不等于新增检测头；可能改变局部细节和上下文的平衡，需实际验证。']},
  activation:{title:'激活函数有什么区别？',intro:'激活函数逐个变换特征值，让网络能够表达非线性关系。这里切换单个选中算子，不会自动替换整个网络的激活函数，也不会改变张量形状。',headers:['函数','对负值和正值的处理','实验时关注什么'],rows:[['SiLU','x × sigmoid(x)。平滑地调节输入，部分负值仍可通过。','当前模板常用的激活；可作为对照。'],['ReLU','max(0, x)。负值变成 0，正值不变。','负半轴梯度为 0，部分单元可能长期不激活。'],['LeakyReLU','正值不变；负值乘小斜率。本工具默认斜率为 0.01。','负半轴仍保留梯度；不同于把负值全部清零。'],['GELU','x × Φ(x)，Φ 为标准正态分布的累积分布函数。平滑调节输入。','本工具使用 PyTorch 默认 approximate=none；计算和设备表现需实测。'],['Identity','y = x，所有值直接通过。','用于测试去掉此处激活的影响；不会移除网络的其他激活。']],notes:['没有一种激活函数在所有检测任务上都最好；请比较精度、召回率、速度和稳定性。','保持数据划分、训练设置与种子一致，先单独改变一个因素。正式实验建议用多个种子重复训练；合成前向检查通过不代表精度更高。']},
  seed:{title:'构建种子有什么用？',intro:'种子控制模型权重的随机初始化。同一结构、同一运行环境和同一种子，可以复现初始权重；42 只是默认值，没有特殊优势。',rows:[['结构对比','先保持种子相同，减少初始化差异带来的干扰。'],['换一个种子','结构不变，初始权重会不同，最终训练结果也可能不同。'],['恢复初始化','恢复当前模板默认结构，以当前种子重新构建；历史修订保留。']],notes:['仅固定构建种子不代表所有设备、所有训练过程都完全一致。']},
  size:{title:'检查与训练尺寸是什么意思？',intro:'这里的尺寸是模型检查和训练使用的正方形输入边长。128 对应高、宽各 128；RGB 输入通道仍是 3。',rows:[['完整维度 NCHW','[批量大小, 通道数, 高, 宽]；例如 [4, 3, 128, 128]。'],['尺寸变大','通常增加计算量和内存占用，并改变输入中的目标像素大小；效果需验证。'],['当前范围','64～1280，必须为 32 的倍数；设计修订与训练尺寸一致。']],notes:['尺寸不是 batch。batch 表示一次处理多少张图片，需在训练页设置。改变尺寸后应重新加载、检查并保存修订。']},
  template:{title:'模型模板与规模',intro:'模板决定初始网络模块和连接。当前提供 YOLOv5u、YOLOv8、YOLO11、YOLO12、YOLO26。模型家族和规模分别选择；n / s / m / l / x 控制网络宽度和深度，同一家族中通常越往后越大。',rows:[['规模与图片尺寸','n/s/m/l/x 是网络规模；128、640 等是输入图片边长，两者独立。更大规模通常需要更多计算与内存。'],['YOLOv5u','Ultralytics 的 YOLOv5u 检测变体，不能视为旧 YOLOv5 仓库的原始权重格式。'],['修改结构参数','当前只开放固定连接下的部分卷积核、池化核与激活。'],['用于新训练','使用检查通过的修订，从零训练，不自动载入预训练权重。']],notes:['更换模板会重置当前编辑；已保存修订保留。']},
  parameters:{title:'通道、步长、填充等参数是什么意思？',intro:'这些参数描述当前选中的真实算子。只读参数仍可观察，当前编辑器没有开放所有参数。',rows:[['输入 / 输出通道','特征图的数量。第一层 RGB 输入为 3；后续通道是学习到的特征。batch 是独立维度。'],['核大小 kernel','单次运算覆盖的空间范围，例如 3×3。'],['步长 stride','窗口每次移动多少格。步长 2 通常让空间尺寸约减半。'],['边缘填充 padding','在边缘补充值，用来控制边界处理和输出大小。'],['分组 groups','将通道分组后分别卷积；逐通道卷积是特殊的分组方式。'],['激活 activation','对特征值做非线性变换；可在激活说明中比较五种选择。'],['BatchNorm / bn','批归一化：训练时使用批统计量，推理时通常使用已保存的统计量。']],notes:['通道数不是图片张数。参数总量也不等于网络深度或精度。当前工具通过真实前向计算显示模块输入输出尺寸。']}
 };
 function open(topic){
  const data=topics[topic]||topics.parameters;el('help-title').textContent=data.title;const body=el('help-body');body.replaceChildren();
  const paragraph=text=>{const p=document.createElement('p');p.textContent=text;body.append(p);};paragraph(data.intro);
  const field=el('field').textContent,matching=topic==='activation'?field==='激活函数':topic==='pool_kernel'?field==='池化核大小':topic==='kernel'?field==='核大小':false;
  if(matching)paragraph(`当前算子：${el('operator-id').textContent||'尚未选择'}；下拉框待选值：${el('value').value||'未选择'}。关闭说明不会应用修改。`);
  const table=document.createElement('table');table.className='design-help-table';
  if(data.headers){const head=table.createTHead().insertRow();for(const title of data.headers){const cell=document.createElement('th');cell.textContent=title;cell.scope='col';head.append(cell);}}
  const rows=table.createTBody();for(const row of data.rows){const tr=rows.insertRow();row.forEach((value,index)=>{const cell=document.createElement(index===0?'th':'td');if(index===0)cell.scope='row';cell.textContent=value;tr.append(cell);});}body.append(table);
  for(const note of data.notes)paragraph(note);
  const nav=document.createElement('div');nav.className='button-row';for(const [id,label]of [['activation','比较激活函数'],['kernel','卷积核'],['parameters','其他参数']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>open(id);nav.append(button);}body.append(nav);
  if(!el('help-dialog').open)el('help-dialog').showModal();body.scrollTop=0;
 }
 document.querySelectorAll('[data-design-help]').forEach(button=>button.onclick=()=>open(button.dataset.designHelp));
 el('parameter-help').onclick=()=>open(el('field').textContent==='激活函数'?'activation':el('field').textContent==='池化核大小'?'pool_kernel':el('field').textContent==='此算子只读'?'parameters':'kernel');
 el('help-close').onclick=()=>el('help-dialog').close();
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&el('help-dialog').open){event.preventDefault();event.stopPropagation();el('help-dialog').close();}},true);
})();
