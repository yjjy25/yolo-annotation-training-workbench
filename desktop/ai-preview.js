/* Read-only AI overlays. Only explicit acceptance creates an editable draft. */
(() => {
 let token=0,current=null,root=null;
 const dialog=$('#ai-preview-dialog');
 function paint(canvas,image,annotation,background=true){
  const width=canvas.width,height=canvas.height,ctx=canvas.getContext('2d');ctx.clearRect(0,0,width,height);
  const iw=image.naturalWidth,ih=image.naturalHeight,scale=Math.min(width/iw,height/ih),ox=(width-iw*scale)/2,oy=(height-ih*scale)/2;
  if(background){ctx.fillStyle='#090c10';ctx.fillRect(0,0,width,height);ctx.drawImage(image,ox,oy,iw*scale,ih*scale);}
  const sx=iw/(annotation.imageWidth||iw),sy=ih/(annotation.imageHeight||ih);
  const point=p=>[ox+p[0]*sx*scale,oy+p[1]*sy*scale];
  ctx.strokeStyle='#ffc45b';ctx.fillStyle='#ffc45b';ctx.lineWidth=2;ctx.setLineDash([7,4]);ctx.font='14px sans-serif';
  for(const shape of annotation.shapes||[]){
   const points=shape.points||[];if(!points.length)continue;const p=point(points[0]);ctx.beginPath();
   if(shape.shape_type==='point'){ctx.arc(...p,4,0,Math.PI*2);ctx.fill();}
   else if(shape.shape_type==='circle'){
    const edge=points[1]||points[0];let rx,ry;
    if(points.length>=3){rx=Math.abs(edge[0]);ry=Math.abs(edge[1]);}else{const radius=Math.hypot(edge[0]-points[0][0],edge[1]-points[0][1]);rx=ry=radius;}
    ctx.ellipse(...p,Math.max(.1,rx*sx*scale),Math.max(.1,ry*sy*scale),0,0,Math.PI*2);ctx.stroke();
   }else{ctx.moveTo(...p);for(const q of points.slice(1))ctx.lineTo(...point(q));ctx.closePath();ctx.stroke();}
   const text=String(shape.label||''),x=Math.max(0,Math.min(width-ctx.measureText(text).width-8,p[0])),y=Math.max(18,p[1]);ctx.setLineDash([]);ctx.fillStyle='#181a20';ctx.fillRect(x,y-18,ctx.measureText(text).width+8,19);ctx.fillStyle='#ffc45b';ctx.fillText(text,x+4,y-4);ctx.setLineDash([7,4]);
  }
  const flags=Object.entries(annotation.flags||{}).filter(([,value])=>value===true).map(([name])=>name);
  if(flags.length){ctx.fillStyle='#181a20';ctx.fillRect(8,8,Math.min(width-16,ctx.measureText(flags.join('、')).width+16),28);ctx.fillStyle='#ffc45b';ctx.fillText(flags.join('、'),16,28);}
 }
 async function source(name,width=1600){
  const [label,asset]=await Promise.all([rpc('load_annotation',{name}),api.asset(name,width)]);
  const image=new Image();image.src=asset.url;await image.decode();return {label,image};
 }
 async function open(name){
  const request=++token,projectRoot=state.project?.root;current=null;root=projectRoot;
  $('#ai-preview-name').textContent=name;$('#ai-preview-info').textContent='正在加载 AI 候选…';$('#ai-preview-edit').disabled=true;$('#ai-preview-open').disabled=true;
  $('#ai-preview-canvas').getContext('2d').clearRect(0,0,$('#ai-preview-canvas').width,$('#ai-preview-canvas').height);dialog.showModal();
  try{
   const {label,image}=await source(name);if(request!==token||root!==state.project?.root||!dialog.open)return;
   current=name;const canvas=$('#ai-preview-canvas');canvas.width=1200;canvas.height=Math.max(260,Math.min(800,1200*image.naturalHeight/image.naturalWidth));
   paint(canvas,image,label.proposal?.annotation||{});
   $('#ai-preview-info').textContent=label.proposal?`${label.proposal.annotation.shapes?.length||0} 个 AI 候选图形 · 橙色虚线为候选，接纳后才能编辑；检查无误再保存审核。`:'当前图片没有待接纳 AI 候选，已有人工标注请在画布查看。';
   $('#ai-preview-edit').disabled=!label.proposal;$('#ai-preview-open').disabled=false;
  }catch(e){$('#ai-preview-info').textContent=e.message;}
 }
 let tileToken=0;
 function renderTiles(){
  const request=++tileToken,projectRoot=state.project?.root;
  for(const tile of $('#gallery').querySelectorAll('.image-tile')){
   tile.querySelector('.tile-ai-overlay')?.remove();if(!$('#dataset-ai-overlay').checked)continue;
   const item=items.find(i=>i.name===tile.dataset.name);if(item?.aiCount===null||item?.aiCount===undefined)continue;
   const img=tile.querySelector('img'),canvas=document.createElement('canvas');canvas.className='tile-ai-overlay';tile.querySelector('.tile-open').append(canvas);
   source(item.name,600).then(({label,image})=>{
    if(request!==tileToken||projectRoot!==state.project?.root||!canvas.isConnected||!label.proposal)return;
    const rect=img.getBoundingClientRect();canvas.width=Math.max(1,Math.round(rect.width*devicePixelRatio));canvas.height=Math.max(1,Math.round(rect.height*devicePixelRatio));canvas.style.height=rect.height+'px';paint(canvas,image,label.proposal.annotation,false);
   }).catch(()=>{});
  }
 }
 $('#dataset-ai-overlay').onchange=renderTiles;
 $('#ai-preview-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{token++;});
 $('#ai-preview-open').onclick=async()=>{const name=current,projectRoot=root;dialog.close();if(name&&projectRoot===state.project?.root)await openImage(name);};
 $('#ai-preview-edit').onclick=async()=>{const name=current,projectRoot=root;dialog.close();if(!name||projectRoot!==state.project?.root)return;await openImage(name);if(editor.name===name&&state.project?.root===projectRoot)await editor.accept();};
 new ResizeObserver(()=>{if($('#dataset-ai-overlay').checked)renderTiles();}).observe($('#gallery'));
 window.aiPreview={open,renderTiles};
})();
