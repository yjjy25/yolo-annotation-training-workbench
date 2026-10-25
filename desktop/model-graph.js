/* Readable module graph. Layout and highlighting do not change model semantics. */
((root)=>{
 const titles={backbone:['① 主干网络','从图片提取特征'],fusion:['② 特征融合','合并不同尺度的特征'],output:['③ 检测输出','输出类别和位置'],network:['网络模块','历史修订未记录分区']};
 const names={Conv:'卷积 · 归一化 · 激活',C2f:'特征提取模块',C3k2:'特征提取模块',C3:'双分支特征模块',A2C2f:'区域注意力特征模块',SPPF:'多尺度池化',C2PSA:'注意力模块',Upsample:'上采样 · 放大特征图',Concat:'拼接不同来源的特征',Detect:'检测头 · 输出预测'};
 function edges(nodes){return nodes.flatMap((node,index)=>{
  const refs=Array.isArray(node.from)?node.from:[node.from];
  return refs.flatMap((ref,port)=>{
   if(index===0&&ref===-1)return [];
   const source=ref<0?index+ref:ref;
   if(!Number.isInteger(ref)||source<0||source>=index)throw Error(`第 ${index} 层包含非法输入来源 ${ref}，已阻止绘制错误结构。`);
   return [{source,target:index,port}];
  });
 });}

 function rounded(points,radius=7){
  let path=`M${points[0][0]} ${points[0][1]}`;
  for(let i=1;i<points.length-1;i++){
   const [a,b,c]=[points[i-1],points[i],points[i+1]],before=Math.hypot(a[0]-b[0],a[1]-b[1]),after=Math.hypot(c[0]-b[0],c[1]-b[1]);
   if(!before||!after)continue;
   const r=Math.min(radius,before/2,after/2),start=b.map((v,j)=>v+(a[j]-v)*r/before),end=b.map((v,j)=>v+(c[j]-v)*r/after);
   path+=` L${start[0]} ${start[1]} Q${b[0]} ${b[1]} ${end[0]} ${end[1]}`;
  }
  const last=points.at(-1);return path+` L${last[0]} ${last[1]}`;
 }
 function layout(nodes){
  const groups=[...new Set(nodes.map(n=>n.section||'network'))],counts={},links=edges(nodes);
  const points=nodes.map((n,i)=>{const section=n.section||'network',row=counts[section]||0;counts[section]=row+1;return {x:60+groups.indexOf(section)*420,y:150+row*140,index:i,section};});
  points.forEach((p,i)=>{if(p.section==='output'){const ys=links.filter(e=>e.target===i).map(e=>points[e.source].y);if(ys.length)p.y=(Math.min(...ys)+Math.max(...ys))/2;}});
  return {groups,points,links,width:groups.length*420+40,height:Math.max(650,...points.map(p=>p.y+160)),counts};
 }
 // Give each nonlocal connection its own vertical lane. Shared trunks imply
 // false junctions even when the stored endpoints are technically correct.
 function routes(plan){
  const used={},counts={};
  const nonlocal=e=>plan.points[e.source].section!==plan.points[e.target].section||e.source!==e.target-1;
  for(const e of plan.links)if(nonlocal(e)){const key=plan.points[e.source].section;counts[key]=(counts[key]||0)+1;}
  return plan.links.map(e=>{
   const a=plan.points[e.source],b=plan.points[e.target];
   if(!nonlocal(e))return {...e,d:`M${a.x+150} ${a.y+106} V${b.y-8}`,labelX:b.x+160,labelY:b.y-12,anchor:'start'};
   const rank=used[a.section]||0;used[a.section]=rank+1;
   const lane=a.x+314+(rank+1)*90/(counts[a.section]+1);
   const same=a.section===b.section,targetX=same?b.x+308:b.x-8,targetY=b.y+35+e.port*16;
   return {...e,lane,d:rounded([[a.x+300,a.y+53],[lane,a.y+53],[lane,targetY],[targetX,targetY]]),labelX:same?b.x+310:b.x-12,labelY:targetY-5,anchor:same?'start':'end'};
  });
 }
 function relatives(count,links,selected){
  const upstream=new Set(),downstream=new Set();
  function walk(key,set,reverse){const queue=[key];while(queue.length){const at=queue.shift();for(const e of links){const a=reverse?e.target:e.source,b=reverse?e.source:e.target;if(a===at&&!set.has(b)&&b!==selected){set.add(b);queue.push(b);}}}}
  if(selected>=0&&selected<count){walk(selected,upstream,true);walk(selected,downstream,false);}return {upstream,downstream};
 }
 const api={layout,edges,relatives,routes};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 if(!root.document)return;
 const ns='http://www.w3.org/2000/svg';
 const svg=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const [key,v]of Object.entries(attrs))n.setAttribute(key,v);if(text!==undefined)n.textContent=text;return n;};
 class View{
  constructor(canvas,onSelect){
   this.canvas=canvas;this.viewport=canvas.parentElement;this.onSelect=onSelect;this.zoom=1;this.selected=-1;
   this.viewport.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('.design-node'))return;this.drag={x:e.clientX,y:e.clientY,left:this.viewport.scrollLeft,top:this.viewport.scrollTop};this.viewport.setPointerCapture(e.pointerId);});
   this.viewport.addEventListener('pointermove',e=>{if(!this.drag)return;this.viewport.scrollLeft=this.drag.left+this.drag.x-e.clientX;this.viewport.scrollTop=this.drag.top+this.drag.y-e.clientY;});
   const release=()=>{this.drag=null;};this.viewport.addEventListener('pointerup',release);this.viewport.addEventListener('pointercancel',release);
   this.viewport.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();this.setZoom(this.zoom+(e.deltaY<0?.1:-.1));},{passive:false});
  }
  setZoom(value){if(!this.plan)return;const old=this.zoom;this.zoom=Math.max(.3,Math.min(3,value));this.canvas.setAttribute('width',this.plan.width*this.zoom);this.canvas.setAttribute('height',this.plan.height*this.zoom);this.viewport.scrollLeft=(this.viewport.scrollLeft+this.viewport.clientWidth/2)*this.zoom/old-this.viewport.clientWidth/2;this.viewport.scrollTop=(this.viewport.scrollTop+this.viewport.clientHeight/2)*this.zoom/old-this.viewport.clientHeight/2;document.getElementById('design-zoom-label').textContent=Math.round(this.zoom*100)+'%';}
  fit(){if(this.plan){this.setZoom((this.viewport.clientWidth-20)/this.plan.width);this.viewport.scrollTo(0,0);}}
  focus(section){const point=this.plan?.points.find(p=>p.section===section);if(point)this.viewport.scrollTo({left:Math.max(0,(point.x-30)*this.zoom),top:Math.max(0,(point.y-130)*this.zoom),behavior:'smooth'});}
  render(nodes,layers,changed,context={}){
   const editedPaths=[...changed];
   this.nodes=nodes;this.plan=layout(nodes);const p=this.plan,canvas=this.canvas;canvas.replaceChildren();canvas.setAttribute('viewBox',`0 0 ${p.width} ${p.height}`);
   const defs=svg('defs',{});for(const [id,color]of [['normal','#8199b5'],['active','#efbc68']]){const marker=svg('marker',{id:'design-arrow-'+id,markerWidth:10,markerHeight:10,refX:9,refY:5,orient:'auto',markerUnits:'userSpaceOnUse'});marker.append(svg('path',{d:'M0 0 L10 5 L0 10 z',fill:color}));defs.append(marker);}canvas.append(defs);
   const navigation=document.getElementById('design-stages');navigation.replaceChildren();
   p.groups.forEach((section,col)=>{
    const title=titles[section]||titles.network,x=35+col*420;
    canvas.append(svg('rect',{x,y:15,width:350,height:p.height-30,rx:18,class:'design-stage '+section}),svg('text',{x:x+20,y:49,class:'design-stage-title'},title[0]),svg('text',{x:x+20,y:77,class:'design-stage-note'},`${title[1]} · ${p.counts[section]} 个模块`));
    const button=document.createElement('button');button.textContent=title[0];button.onclick=()=>this.focus(section);navigation.append(button);
   });
   canvas.append(svg('text',{x:60,y:122,class:'design-input-note'},`输入 NCHW · [1, 3, ${context.imgsz||'H'}, ${context.imgsz||'W'}]`));
   if(p.points.length){const first=p.points[0];canvas.append(svg('path',{d:`M${first.x+150} 130 V${first.y-8}`,class:'design-input-edge','marker-end':'url(#design-arrow-normal)'}));}
   for(const e of routes(p)){
    const line=svg('path',{d:e.d,class:'design-edge','data-source':e.source,'data-target':e.target,'marker-end':'url(#design-arrow-normal)'});line.append(svg('title',{},`第 ${e.source} 层 → 第 ${e.target} 层 · 输入 ${e.port+1}`));canvas.append(line);
    canvas.append(svg('text',{x:e.labelX,y:e.labelY,'text-anchor':e.anchor,class:'design-edge-label','data-source':e.source,'data-target':e.target},`${e.source} → ${e.target}`));
   }
   nodes.forEach((node,i)=>{
    const at=p.points[i],edited=editedPaths.some(path=>path.startsWith(node.id+'.'));
    const kind=node.type==='Detect'?'output':node.type==='Concat'?'merge':node.type==='Upsample'?'resize':node.type==='SPPF'?'pool':['C2PSA','A2C2f'].includes(node.type)?'attention':['C2f','C3','C3k2'].includes(node.type)?'feature':'conv';
    const g=svg('g',{tabindex:0,role:'button','aria-label':`第 ${i} 层 ${names[node.type]||node.type}`,class:'design-node design-kind-'+kind+(edited?' changed':''),'data-index':i});
    const conv=layers.find(l=>l.id===node.id+'.conv'),inside=layers.filter(l=>l.id===node.id||l.id.startsWith(node.id+'.')).length;
    const detail=conv?`${conv.params.kernel.join('×')} 卷积 · ${conv.params.in_channels} → ${conv.params.out_channels} 通道`:node.type==='Detect'?`${p.links.filter(e=>e.target===i).length} 路特征输入 · ${context.nc||'?'} 个类别`:`可查看 ${inside} 个算子 · 参数 ${Number(node.parameters).toLocaleString()}`;
    const output=node.execution?.output,shape=Array.isArray(output)&&output.length===4&&output.every(Number.isInteger)?output.slice(2).join('×'):node.type==='Detect'?'检测输出':'';
    g.append(svg('rect',{x:at.x,y:at.y,width:300,height:106,rx:13,class:'design-node-card'}),
     svg('rect',{x:at.x+12,y:at.y+10,width:34,height:24,rx:7,class:'design-node-index-bg'}),
     svg('text',{x:at.x+29,y:at.y+27,'text-anchor':'middle',class:'design-node-number'},String(i).padStart(2,'0')),
     svg('text',{x:at.x+56,y:at.y+27,class:'design-node-type'},node.type),
     svg('text',{x:at.x+282,y:at.y+27,'text-anchor':'end',class:'design-node-state'},edited?'已修改':shape),
     svg('text',{x:at.x+16,y:at.y+59,class:'design-node-name'},names[node.type]||node.type),
     svg('text',{x:at.x+16,y:at.y+85,class:'design-node-detail'},detail));
    const tooltip=svg('title',{},`第 ${i} 层 ${node.type}\n${detail}${shape?'\n输出空间：'+shape:''}`);g.append(tooltip);

    const choose=()=>{this.select(i);this.onSelect(node);};g.onclick=choose;g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}};canvas.append(g);
   });
   this.setZoom(this.zoom);this.select(this.selected);
  }
  select(index){
   if(!this.plan)return;this.selected=index;const {upstream,downstream}=relatives(this.nodes.length,this.plan.links,index);
   this.canvas.querySelectorAll('.design-node').forEach(n=>{const i=Number(n.dataset.index);n.classList.toggle('selected',i===index);n.classList.toggle('dimmed',index>=0&&i!==index&&!upstream.has(i)&&!downstream.has(i));n.setAttribute('aria-pressed',String(i===index));});
   this.canvas.querySelectorAll('.design-edge').forEach(n=>{const a=Number(n.dataset.source),b=Number(n.dataset.target),active=index>=0&&((upstream.has(a)&&(upstream.has(b)||b===index))||((a===index||downstream.has(a))&&downstream.has(b)));n.classList.toggle('active',active);n.classList.toggle('direct',a===index||b===index);n.classList.toggle('dimmed',index>=0&&!active);n.setAttribute('marker-end',`url(#design-arrow-${active?'active':'normal'})`);});
   this.canvas.querySelectorAll('.design-edge-label').forEach(n=>n.classList.toggle('visible',index>=0&&(Number(n.dataset.source)===index||Number(n.dataset.target)===index)));
   const summary=document.getElementById('design-selection');
   if(index<0||!this.nodes[index]){summary.textContent='点击模块查看输入来源；金色连线显示选中模块的上下游路径。';return;}
   const inputs=this.plan.links.filter(e=>e.target===index).map(e=>'第 '+e.source+' 层'),outputs=this.plan.links.filter(e=>e.source===index).map(e=>'第 '+e.target+' 层');summary.textContent=`当前：第 ${index} 层 ${names[this.nodes[index].type]||this.nodes[index].type}。输入：${inputs.join('、')||'输入图片'}。流向：${outputs.join('、')||'模型输出'}。`;
  }
 }
 api.View=View;root.ModelGraph=api;
})(typeof window==='undefined'?globalThis:window);
