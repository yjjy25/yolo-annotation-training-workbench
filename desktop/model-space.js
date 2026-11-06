/* Native 3D plates, real module hierarchy and measured tensor dimensions. */
((root)=>{
 const tensor=s=>Array.isArray(s)&&s.length===4&&s.every(n=>Number.isInteger(n)&&n>0);
 function tensors(s){return tensor(s)?[s]:Array.isArray(s)?s.flatMap(tensors):[];}
 function summary(s){const rows=tensors(s);return rows.length?rows.map(n=>`${n[2]} × ${n[3]} · ${n[1]} 通道`).join(' / '):'未测得';}
 function dimensions(s){return tensor(s)?[42+Math.log2(s[3]+1)*9,32+Math.log2(s[2]+1)*7,8+Math.log2(s[1]+1)*3]:[80,62,10];}
 function rotate(p,yaw,pitch){const x=p[0]*Math.cos(yaw)+p[2]*Math.sin(yaw),z=-p[0]*Math.sin(yaw)+p[2]*Math.cos(yaw);return [x,p[1]*Math.cos(pitch)-z*Math.sin(pitch),p[1]*Math.sin(pitch)+z*Math.cos(pitch)];}
 function project(p,c,w,h){const v=rotate(p,c.yaw,c.pitch);return [w/2+v[0]*c.scale+c.x,h/2+v[1]*c.scale+c.y,v[2]];}
 const own=(id,parent)=>id===parent||id.startsWith(parent+'.');
 const names={Conv2d:'卷积',BatchNorm2d:'归一化',SiLU:'SiLU 激活',ReLU:'ReLU 激活',GELU:'GELU 激活',Identity:'直接通过',MaxPool2d:'最大池化',Conv:'卷积组',C2f:'特征块',C3k2:'特征块',C2PSA:'注意力',Upsample:'上采样',Concat:'拼接',Detect:'检测头',SPPF:'池化融合'};
 function hierarchy(info,id,shapes={}){
  const tree=(info.module_tree||[]).filter(n=>own(n.id,id)),leaves=(info.layers||[]).filter(n=>own(n.id,id));
  const byId=new Map(tree.map(n=>[n.id,n])),units=new Map();
  for(const leaf of leaves){
   const parent=leaf.id.slice(0,leaf.id.lastIndexOf('.')),wrapper=byId.get(parent);
   const key=wrapper&&['Conv','DWConv'].includes(wrapper.type)?parent:leaf.id;
   if(!units.has(key))units.set(key,{id:key,type:byId.get(key)?.type||leaf.type,layers:[]});
   units.get(key).layers.push({...leaf,measurement:shapes[leaf.id]||null});
  }
  const blocks=tree.filter(n=>['Bottleneck','C3k','PSABlock','ABlock'].includes(n.type));
  const depth=tree.length?Math.max(...tree.map(n=>n.id.split('.').length-id.split('.').length)):0;
  return {id,tree,leaves,units:[...units.values()],blocks,depth,
   calls:leaves.filter(n=>shapes[n.id]?.calls?.length>1).map(n=>({id:n.id,count:shapes[n.id].calls.length}))};
 }
 function scene(nodes,context={},info={layers:[],module_tree:[]},shapes={}){
  const links=root.ModelGraph?.edges?root.ModelGraph.edges(nodes):[],groups=[...new Set(nodes.map(n=>n.section||'network'))],counts={};
  const items=nodes.map((node,index)=>{
   const section=node.section||'network',row=counts[section]||0;counts[section]=row+1;
   const output=tensors(node.execution?.output)[0]||null,detail=hierarchy(info,node.id,shapes),column=Math.floor(row/4);
   const count=nodes.filter(n=>(n.section||'network')===section).length;
   return {index,node,path:node.id,shape:output,position:[(groups.indexOf(section)-(groups.length-1)/2)*700+column*210,(row%4-(Math.min(count,4)-1)/2)*205,0],
    size:[132,52,10],detail,stack:Math.min(5,Math.max(1,detail.leaves.length)),section};
  });
  return {kind:'network',items,links,groups,input:[1,3,context.imgsz||128,context.imgsz||128]};
 }
 function detailScene(info,id,shapes={}){
  const detail=hierarchy(info,id,shapes),groups=new Map(),items=[],shelves=[];
  for(const unit of detail.units){
   const ancestors=detail.blocks.filter(b=>own(unit.id,b.id));
   const group=ancestors.at(-1),key=group?.id||id;
   if(!groups.has(key))groups.set(key,{id:key,type:group?.type||info.module_tree?.find(n=>n.id===id)?.type||'模块',units:[]});
   groups.get(key).units.push(unit);
  }
  let row=0;
  for(const group of groups.values()){
   const start=row;
   group.units.forEach((unit,i)=>{
    const x=(i%2)*265-132.5,y=(row+Math.floor(i/2))*260;
    unit.layers.forEach((leaf,j)=>items.push({index:items.length,node:{id:leaf.id,type:leaf.type},path:leaf.id,unit:unit.id,
     label:names[leaf.type]||leaf.type,shape:tensors(leaf.measurement?.output)[0]||null,measurement:leaf.measurement,
     position:[x,y-j*58,-j*30],size:[194,58,8],section:'backbone',group:group.id}));
   });
   row+=Math.ceil(group.units.length/2);
   shelves.push({...group,y:start*260,height:(row-start)*260});
  }
  const center=(Math.max(1,row)-1)*130;items.forEach(n=>n.position[1]-=center);shelves.forEach(n=>n.y-=center);
  return {kind:'layers',items,links:[],detail,shelves};
 }
 function fitCamera(data,w,h,local=false){
  const camera={yaw:data.kind==='layers'?-.24:-.30,pitch:.32,scale:1,x:0,y:0};
  const bounds=data.items.flatMap(n=>[-1,1].flatMap(a=>[-1,1].flatMap(b=>[-1,1].map(c=>rotate([a*n.size[0]/2+n.position[0],b*n.size[1]/2+n.position[1],(local?c*n.size[2]/2:c<0?-80:30)+n.position[2]],camera.yaw,camera.pitch)))));
  if(!bounds.length)return {...camera,baseScale:1};
  const span=a=>Math.max(...bounds.map(p=>p[a]))-Math.min(...bounds.map(p=>p[a])),center=a=>(Math.max(...bounds.map(p=>p[a]))+Math.min(...bounds.map(p=>p[a])))/2;
  const scale=Math.max(.10,Math.min((w-(local?30:60))/(span(0)+(local?20:70)),(h-(local?35:100))/(span(1)+(local?8:90)),local?1.1:1.15));
  return {...camera,baseScale:scale,scale,x:-center(0)*scale,y:-center(1)*scale+(local?0:6)};
 }
 const api={tensor,tensors,summary,dimensions,rotate,project,scene,hierarchy,detailScene,fitCamera};
 if(typeof module!=='undefined')module.exports=api;root.ModelSpace=api;if(!root.document)return;
 const dark={backbone:[99,149,184],fusion:[153,133,185],output:[93,163,145],network:[99,149,184]},light={backbone:[67,123,165],fusion:[129,98,166],output:[51,134,111]};
 const rgb=(c,k=1)=>`rgb(${c.map(n=>Math.min(255,Math.round(n*k))).join(',')})`;
 class View{
  constructor(canvas,onSelect,{local=false}={}){
   Object.assign(this,{canvas,ctx:canvas.getContext('2d'),onSelect,local,selected:-1,hits:[],camera:{yaw:-.30,pitch:.32,scale:1,x:0,y:0}});
   this.observer=new ResizeObserver(()=>this.needsFit?this.fit():this.paint());this.observer.observe(canvas.parentElement);
   canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;this.drag={x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,pan:e.shiftKey};canvas.setPointerCapture(e.pointerId);});
   canvas.addEventListener('pointermove',e=>{
    if(!this.drag){const item=this.hit(e)?.item;canvas.title=item?`${item.path} ${item.node.type}\n输入：${summary(item.measurement?.input||item.node.execution?.input)}\n输出：${summary(item.measurement?.output||item.node.execution?.output)}`:'';return;}
    const dx=e.clientX-this.drag.lastX,dy=e.clientY-this.drag.lastY;Object.assign(this.drag,{lastX:e.clientX,lastY:e.clientY});
    if(this.drag.pan){this.camera.x+=dx;this.camera.y+=dy;}else{this.camera.yaw=Math.max(-1.1,Math.min(1.1,this.camera.yaw+dx*.005));this.camera.pitch=Math.max(-.75,Math.min(.85,this.camera.pitch+dy*.004));}this.paint();
   });
   canvas.addEventListener('pointerup',e=>{const d=this.drag;this.drag=null;if(d&&Math.hypot(e.clientX-d.x,e.clientY-d.y)<5){const hit=this.hit(e);if(hit){if(this.data.kind==='network')this.select(hit.item.index);this.onSelect?.(hit.item.node);}}});
   canvas.addEventListener('pointercancel',()=>this.drag=null);
   canvas.addEventListener('dblclick',e=>{const hit=this.hit(e);if(hit&&this.data.kind==='network')this.open(hit.item.path);});
   canvas.addEventListener('wheel',e=>{e.preventDefault();this.setZoom(this.zoom*(e.deltaY<0?1.12:.89));},{passive:false});
   canvas.addEventListener('keydown',e=>{
    if(!this.data?.items.length)return;
    if(['ArrowDown','ArrowRight','ArrowUp','ArrowLeft','Home'].includes(e.key)){e.preventDefault();const list=this.data.items,at=this.data.kind==='network'?this.selected:list.findIndex(n=>n.path===this.focusedPath),index=e.key==='Home'?0:Math.max(0,Math.min(list.length-1,at+(['ArrowDown','ArrowRight'].includes(e.key)?1:-1)));if(this.data.kind==='network')this.select(index);this.onSelect?.(list[index].node);}
    if(e.key==='Enter'&&this.data.kind==='network')this.open(this.nodes?.[this.selected]?.id);
    if(e.key==='Escape')this.overview();if(e.key==='0')this.fit();
   });
   new MutationObserver(()=>this.paint()).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  }
  hit(e){const r=this.canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;return [...this.hits].reverse().find(h=>x>=h.x&&x<=h.x+h.w&&y>=h.y&&y<=h.y+h.h);}
  get zoom(){return this.camera.scale/(this.baseScale||1);}
  setZoom(value){this.camera.scale=(this.baseScale||1)*Math.max(.3,Math.min(5,value));this.paint();this.zoomLabel();}
  zoomLabel(){if(!this.local)document.getElementById('design-zoom-label').textContent=Math.round(this.zoom*100)+'%';}
  fit(){
   if(!this.data?.items.length){this.paint();return;}
   const w=this.canvas.parentElement.clientWidth,h=this.canvas.parentElement.clientHeight;if(w<1||h<1){this.needsFit=true;return;}this.needsFit=false;
   this.camera=fitCamera(this.data,w,h,this.local);this.baseScale=this.camera.baseScale;this.paint();this.zoomLabel();
  }
  render(nodes,layers,changed,context={},info={},shapes={}){
   this.nodes=nodes;this.info={...info,layers};this.shapes=shapes;this.context=context;this.edited=[...changed];
   if(this.detailRoot&&!this.info.module_tree?.some(n=>n.id===this.detailRoot))this.detailRoot=null;
   this.rebuild();
  }
  rebuild(){if(!this.nodes)return;this.data=this.detailRoot?detailScene(this.info,this.detailRoot,this.shapes):scene(this.nodes,this.context,this.info,this.shapes);this.onModeChange?.();this.needsFit=true;requestAnimationFrame(()=>this.fit());}
  open(path){if(!path||!this.nodes||!this.info.module_tree?.some(n=>n.id===path)||!this.info.layers.some(n=>own(n.id,path)))return;this.detailRoot=path;this.rebuild();}
  up(){if(!this.detailRoot)return;const parent=this.detailRoot.slice(0,this.detailRoot.lastIndexOf('.'));if(/^model\.\d+/.test(parent))this.open(parent);else this.overview();}
  overview(){this.detailRoot=null;this.rebuild();}
  clear(){this.data=null;this.hits=[];this.paint();}
  select(index){const previous=this.selected;this.selected=index;if(this.detailRoot&&this.nodes?.[index]&&(previous!==index||this.focusedPath&&!own(this.focusedPath,this.detailRoot))){this.detailRoot=this.nodes[index].id;this.rebuild();}else this.paint();}
  focus(section){const node=this.nodes?.find(n=>n.section===section);if(node)this.onSelect?.(node);}
  localPair(input,output,path){const items=[];for(const [s,x,label]of [[input,-105,'输入'],[output,105,'输出']])tensors(s).forEach((shape,i)=>items.push({index:items.length,path,node:{id:path,type:label},label,shape,position:[x,i*100,0],size:dimensions(shape),section:x<0?'backbone':'output',stack:1}));this.data={kind:'local',items,links:[]};this.fit();}
  paint(){
   const {canvas,ctx}=this,r=canvas.parentElement.getBoundingClientRect();if(r.width<1||r.height<1)return;
   const w=r.width,h=r.height,dpr=Math.min(2,devicePixelRatio||1);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);this.hits=[];
   const pale=document.documentElement.dataset.theme==='light',ink=pale?'#293a4c':'#e0e8f2',muted=pale?'#65768a':'#8e9eb2',accent=pale?'#95671e':'#e8bc76',bg=pale?'#f4f7fa':'#111923';
   if(!this.local){ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);}const data=this.data;
   if(!data?.items.length){ctx.fillStyle=muted;ctx.font='13px "Microsoft YaHei",sans-serif';ctx.textAlign='center';ctx.fillText('加载结构，查看网络与内部层级',w/2,h/2);return;}
   const proj=p=>project(p,this.camera,w,h),paths=data.kind==='network'&&this.selected>=0?root.ModelGraph.relatives(data.items.length,data.links,this.selected):null;
   // Orthogonal bus lanes show only declared module inputs. No interior wires are invented.
   for(const e of data.links){const a=proj(data.items[e.source].position),b=proj(data.items[e.target].position),direct=e.source===this.selected||e.target===this.selected;
    ctx.strokeStyle=direct?accent:pale?'#aebdca':'#41546a';ctx.globalAlpha=direct?.9:.4;ctx.lineWidth=direct?1.8:1;
    const bend=(a[0]+b[0])/2;ctx.beginPath();ctx.moveTo(a[0],a[1]+10);if(Math.abs(a[0]-b[0])<20)ctx.lineTo(b[0],b[1]-10);else{ctx.lineTo(bend,a[1]+10);ctx.lineTo(bend,b[1]-10);ctx.lineTo(b[0],b[1]-10);}ctx.stroke();
   }ctx.globalAlpha=1;
   if(data.kind==='layers'){
    for(const shelf of data.shelves){
     const members=data.items.filter(n=>n.group===shelf.id),points=members.flatMap(n=>[[-104,-35,-6],[104,35,6]].map(v=>proj(v.map((k,i)=>k+n.position[i]))));
     const left=Math.min(...points.map(p=>p[0]))-12,right=Math.max(...points.map(p=>p[0]))+12,top=Math.min(...points.map(p=>p[1]))-7,bottom=Math.max(...points.map(p=>p[1]))+15;
     ctx.fillStyle=pale?'#e7edf4':'#172230';ctx.beginPath();ctx.roundRect(left,top,right-left,bottom-top,8);ctx.fill();
     ctx.fillStyle=muted;ctx.font='10px "Microsoft YaHei",sans-serif';ctx.textAlign='right';const key=shelf.id.split('.').at(-1);ctx.fillText(shelf.id===data.detail.id?'外层':/^\d+$/.test(key)?'块 '+key:key,left-10,(top+bottom)/2);
    }
   }
   const plates=[];
   for(const item of data.items){
    const selected=data.kind==='network'?item.index===this.selected:item.path===this.focusedPath;
    const count=data.kind==='network'?item.stack||1:1;
    for(let i=0;i<count;i++){
     const position=item.position.map((n,a)=>a===2?n-i*15:n),size=item.size;
     const vertices=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(v=>proj(v.map((n,a)=>n*size[a]/2+position[a])));
     plates.push({item,selected,vertices,z:proj(position)[2],front:i===0});
    }
   }
   plates.sort((a,b)=>a.z-b.z);
   for(const p of plates){
    const {item,vertices:v,selected}=p,layerColor=item.node.type==='BatchNorm2d'?[110,127,148]:['SiLU','ReLU','LeakyReLU','GELU','Identity'].includes(item.node.type)?[83,149,136]:[90,143,178],c=selected?(pale?[183,136,61]:[207,167,102]):data.kind==='layers'?layerColor:(pale?light:dark)[item.section]||dark.network;
    const dim=paths&&!selected&&!paths.upstream.has(item.index)&&!paths.downstream.has(item.index);ctx.globalAlpha=dim?.35:1;
    const faces=[[0,1,2,3],[4,5,6,7],[0,4,7,3],[1,5,6,2],[0,1,5,4],[3,2,6,7]].map((f,i)=>({f,i,z:f.reduce((s,k)=>s+v[k][2],0)/4})).sort((a,b)=>a.z-b.z);
    for(const face of faces){ctx.beginPath();face.f.forEach((k,j)=>j?ctx.lineTo(v[k][0],v[k][1]):ctx.moveTo(v[k][0],v[k][1]));ctx.closePath();ctx.fillStyle=rgb(c,[.68,.80,.65,.76,1.16,.62][face.i]);ctx.fill();ctx.strokeStyle=pale?'#ffffff50':'#ffffff22';ctx.lineWidth=.6;ctx.stroke();}
    const xs=v.map(n=>n[0]),ys=v.map(n=>n[1]),x=Math.min(...xs),y=Math.min(...ys),rw=Math.max(...xs)-x,rh=Math.max(...ys)-y;
    if(selected){ctx.strokeStyle=accent;ctx.lineWidth=1.6;ctx.strokeRect(x-3,y-3,rw+6,rh+6);}
    this.hits.push({item,x:x-4,y:y-4,w:rw+8,h:rh+8});
    if(data.kind==='layers'){
     const center=proj(item.position);ctx.font='11px "Microsoft YaHei",sans-serif';ctx.textAlign='center';ctx.fillStyle=selected&&!pale?'#251c10':'#f8fbff';
     const label=item.node.type==='Conv2d'?`${(this.info.layers.find(n=>n.id===item.path)?.params.kernel||[]).join('×')} 卷积`:item.node.type==='BatchNorm2d'?'BN':item.node.type.replace(/2d$/,'');
     ctx.fillText(label,center[0],center[1]+3);
    }else if(data.kind==='network'&&p.front&&item.detail.leaves.length>1){const center=proj(item.position);ctx.fillStyle=selected&&!pale?'#251c10':'#f8fbff';ctx.textAlign='center';ctx.font='9px "Microsoft YaHei",sans-serif';ctx.fillText('×'+item.detail.leaves.length,center[0],center[1]+3);
    }
   }ctx.globalAlpha=1;
   for(const item of data.items){
    if(data.kind==='layers'&&data.items.some(n=>n.unit===item.unit&&n.position[2]>item.position[2]))continue;
    const center=proj(item.position),pos=proj([item.position[0],item.position[1]+item.size[1]/2+28,item.position[2]]);
    ctx.textAlign='center';ctx.font='12px "Microsoft YaHei",sans-serif';ctx.fillStyle=ink;
    if(data.kind==='network'){
     const detail=item.detail,short={Conv:'卷积',Concat:'拼接',Upsample:'放大',Detect:'检测',SPPF:'池化',C2PSA:'注意力',A2C2f:'区域块'};
     ctx.fillText(`${String(item.index).padStart(2,'0')} ${short[item.node.type]||item.node.type}`,pos[0],pos[1]+4);ctx.font='9px "Microsoft YaHei",sans-serif';ctx.fillStyle=muted;
     if(item.index===this.selected)ctx.fillText(`${detail.blocks.length?detail.blocks.length+' 块 / ':''}${detail.leaves.length||1} 算子`,pos[0],pos[1]+17);
    }else if(data.kind==='layers'){
     ctx.font='10px "Microsoft YaHei",sans-serif';ctx.fillText(item.unit.split('.').at(-1),pos[0],pos[1]);
    }else{const hit=this.hits.find(n=>n.item===item);ctx.fillText(item.label,center[0],Math.max(14,hit.y-9));}
   }
   if(data.kind==='local'){ctx.font='18px sans-serif';ctx.textAlign='center';ctx.fillStyle=muted;ctx.fillText('→',w/2,h/2);}
  }
 }
 api.View=View;
})(typeof window==='undefined'?globalThis:window);
