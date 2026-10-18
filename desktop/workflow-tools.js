/* Video sequences and project-specific pose reference, sharing the real editor. */
(() => {
 let sequences=[],sequence=null,poll=null,importing=false,reference=null,highlight=-1,sequenceRoot=null,sequenceToken=0,photoExamples=[],photoHits=[];
 const timing=s=>Number(s).toFixed(2)+' 秒';
 const selectedSequence=()=>sequences.find(s=>s.id===$('#video-sequence').value);
 async function refreshSequences(){
  const root=state.project?.root,token=++sequenceToken;
  if(!root){sequences=[];sequence=null;sequenceRoot=null;$('#video-timeline').hidden=true;return;}
  const records=await rpc('video_sequences');if(token!==sequenceToken||state.project?.root!==root)return;
  sequences=records.filter(s=>s.kind!=='tracking');sequenceRoot=root;
  const select=$('#video-sequence'),previous=select.value;select.replaceChildren();
  for(const record of sequences){const option=new Option(record.source_name+' · '+record.frames.length+' 帧',record.id);select.add(option);}
  if(sequences.some(s=>s.id===previous))select.value=previous;
  syncTimeline();
 }
 window.refreshVideoSequences=refreshSequences;
 function syncTimeline(){
  if(window.videoTracking?.ownsTimeline()){window.videoTracking.syncTimeline();return;}
  sequence=sequenceRoot===state.project?.root?sequences.find(s=>s.frames.some(f=>f.name===editor.name))||null:null;
  $('#video-timeline').hidden=!sequence;
  if(!sequence){
   $('#video-position').value=0;$('#video-position').max=0;
   $('#video-prev').disabled=true;$('#video-next').disabled=true;$('#video-time').textContent='';return;
  }
  $('#video-sequence').value=sequence.id;
  const current=sequence;
  // Manually extracted videos keep their own frame navigation; tracking is excluded above.
  $('.canvas-area')?.insertBefore($('#video-timeline'),$('#canvas-host'));
  if(current.storage==='video-work'&&window.videoTracking?.syncTimeline){window.videoTracking.syncTimeline(current);return;}
  $('#video-position').min=0;
  const at=current.frames.findIndex(f=>f.name===editor.name);
  $('#video-position').max=current.frames.length-1;$('#video-position').value=Math.max(0,at);
  $('#video-prev').disabled=at<=0;$('#video-next').disabled=at>=current.frames.length-1;
  $('#video-time').textContent=at<0?'选择片段开始标注':`${at+1}/${current.frames.length} · 原帧 ${current.frames[at].frame} · ${timing(current.frames[at].seconds)}`;
 }
 async function openFrame(index){
  const record=selectedSequence();if(!record)return;
  if(record.storage==='video-work')return window.videoTracking.seekFrame(Math.max(record.frames[0].frame,index),record.id);
  const frame=record.frames[Math.min(record.frames.length-1,Math.max(0,index))];
  if(!frame)return;
  if(!await window.workbench.asset(frame.name).catch(()=>null)){toast('此帧已移出数据集，请换一帧。');return;}
  await openImage(frame.name);syncTimeline();
 }
 $('#video-sequence').onchange=()=>openFrame(0).catch(e=>toast(e.message));
 $('#video-position').onchange=()=>openFrame(Number($('#video-position').value)).catch(e=>toast(e.message));
 for(const [id,step] of [['#video-prev',-1],['#video-next',1]])$(id).onclick=()=>Promise.resolve(window.videoTracking?.navigate(step)??openFrame(Number($('#video-position').value)+step)).catch(e=>toast(e.message));
 // Reuse A/D, arrows and "approve next" while inside a video, independently of gallery pagination.
 const imageNavigate=editor.callbacks.navigate;
 const videoNavigate=step=>window.videoTracking?.navigate(step)??(sequence?openFrame(Number($('#video-position').value)+step):imageNavigate(step));
 editor.callbacks.navigate=videoNavigate;
 const originalNavigate=navigate;
 navigate=async step=>{if(sequence&&page==='editor')return openFrame(Number($('#video-position').value)+step);return originalNavigate(step);};
 const originalOpen=editor.open.bind(editor);
 editor.open=async name=>{const opened=await originalOpen(name);syncTimeline();return opened;};
 const originalForget=editor.forget.bind(editor);
 editor.forget=()=>{originalForget();syncTimeline();};
 const originalProject=editor.setProject.bind(editor);
 editor.setProject=project=>{const changed=sequenceRoot!==project?.root;originalProject(project);if(changed){sequence=null;sequences=[];$('#video-timeline').hidden=true;refreshSequences().catch(e=>toast(e.message));}};
 window.showVideoImport=path=>{if(path)$('#video-path').value=path;$('#video-dialog').showModal();};
 $('#video-close').onclick=()=>$('#video-dialog').close();
 $('#video-choose').onclick=async()=>{const path=await api.choose('video');if(path)$('#video-path').value=path;};
 function busy(value){importing=value;$('#video-submit').disabled=value;$('#video-cancel').disabled=!value;for(const id of ['path','choose','start','end','step','limit'])$('#video-'+id).disabled=value;}
 async function checkProgress(){
  try{
   const result=await rpc('video_status');
   $('#video-status').textContent=result.error||({running:`正在抽帧，已暂存 ${result.count||0} 帧…`,completed:`已导入 ${result.count} 帧${result.limited?'（达到本次上限）':''}。每帧需人工标注和审核。`,stopped:result.message||'已取消导入。'}[result.status]||'等待选择视频');
   if(['completed','failed','stopped'].includes(result.status)){
    clearInterval(poll);poll=null;busy(false);
    if(result.status==='completed'){
     await api.state().then(update);galleryKey='';await loadImages();await refreshSequences();
     $('#video-dialog').close();$('#video-sequence').value=result.id;await openFrame(0);toast('视频帧已导入，可在画布上逐帧标注。');
    }
   }
  }catch(e){clearInterval(poll);poll=null;busy(false);$('#video-status').textContent=e.message;}
 }
 $('#video-form').onsubmit=async event=>{
  event.preventDefault();if(importing)return;busy(true);
  try{
   await editor.save();
   await rpc('import_video',{path:$('#video-path').value.trim(),start:Number($('#video-start').value),end:Number($('#video-end').value),step:Number($('#video-step').value),limit:Number($('#video-limit').value)});
   $('#video-status').textContent='正在打开视频…';poll=setInterval(checkProgress,800);await checkProgress();
  }catch(e){busy(false);$('#video-status').textContent=e.message;}
 };
 $('#video-cancel').onclick=async()=>{await rpc('stop_video');$('#video-status').textContent='正在取消，已保存标注不受影响…';};

 const standard=[
  ['目标框与实例','每个对象先画紧贴可见范围的框，同一对象的所有骨点共用实例编号。多个对象分别标注，不能把别的对象骨点连进来。'],
  ['左右与顺序','左/右以对象自身为准，不以屏幕左右为准。模板编号与导出顺序固定；镜像只改变位置，不改变名称与左右配对。'],
  ['可见点 v=2','能直接看清位置：放在关节中心、鼻尖、爪尖等约定位置。取消“遮挡”。同一骨点在不同照片上使用相同解剖定义。'],
  ['遮挡点 v=1','被毛发、肢体或物体挡住，但位置可以可靠判断：放点并勾选遮挡（O）。无法可靠判断时设为未知，不凭模板位置猜测。'],
  ['未知点 v=0','在画面外或无法可靠定位：顺序点选按 K 跳过；已有骨点选中后按 K 移除。导出时该点为 0 0 0；不是把点拖到图片角落。'],
  ['微调与审核','鼠标移到已有骨点上直接拖动；顺序点选时也能微调已放点。拖动后检查遮挡状态。全部检查完成再“确认无误”；保存草稿时可关闭“保存即审核”。'],
  ['视频一致性','逐帧检查实例、左右和遮挡，不自动沿用上一帧位置。不确定的点标未知。此功能按帧标注，不自动跟踪；跨帧实例编号需人工保持一致。'],
 ];
 function landmarkRule(name){
  if(/eye/.test(name))return '眼球可见区域中心。闭眼时按眼裂中心定位；无法判断则设为未知。';
  if(/nose/.test(name))return '鼻尖中央；不要点在脸部轮廓或鼻梁上。';
  if(/ear_tip/.test(name))return '耳廓最远端的尖端。耳根与耳尖是不同点。';
  if(/ear_base/.test(name))return '耳廓与头部连接的根部中心。';
  if(/ear/.test(name))return '人体耳部中心附近，左右按人物自身区分；遮挡且无法可靠定位时设为未知。';
  if(/shoulder/.test(name))return '肩关节中心；不是衣袖边缘或肩部最外侧轮廓。';
  if(/elbow/.test(name))return '对应肢体关节的中心，沿模板连线确认所属肢体。动物预设保留上游名称；后肢同名点需统一项目解剖约定。';
  if(/wrist/.test(name))return '腕关节中心，位于前臂与手掌连接处。';
  if(/hip/.test(name))return '髋关节中心附近，保持同一解剖定义；不能用裤袋或外侧衣物边缘代替。';
  if(/knee/.test(name))return '模板对应肢体中间关节的中心；狗预设的前/后肢名称按项目规范统一，不凭屏幕上下判断。';
  if(/ankle/.test(name))return '踝关节中心，位于小腿与足部连接处。';
  if(/paw/.test(name))return '对应爪部中心/接地端中心；整个项目保持同一取点规则。';
  if(/tail_start/.test(name))return '尾部与躯干连接的尾根中心。';
  if(/tail_end/.test(name))return '尾巴可判断的末端尖点；出画且无法判断时设为未知。';
  if(/chin/.test(name))return '下颌前端中央，与鼻尖分开标注。';
  if(/withers/.test(name))return '颈后与肩背交界处的肩隆中心。';
  if(/throat/.test(name))return '头颈连接处腹侧的喉部中心。';
  return '自定义点：请先在项目规范中约定固定的物理位置，用一张审核照片作为统一参考；没有可信位置时设为未知。';
 }
 function drawDiagram(){
  const canvas=$('#pose-diagram'),ctx=canvas.getContext('2d'),t=state.project?.template;if(!t)return;
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#18212e';ctx.fillRect(0,0,520,420);
  const coords=t.points.map((_,i)=>{const p=t.positions?.[i]||[.15+(i%6)*.14,.12+Math.floor(i/6)*(.76/Math.max(1,Math.ceil(t.points.length/6)))];return [40+p[0]*440,30+p[1]*350];});
  ctx.strokeStyle='#85a7ba';ctx.lineWidth=2;
  for(const [a,b] of t.edges||[]){if(!coords[a]||!coords[b])continue;ctx.beginPath();ctx.moveTo(...coords[a]);ctx.lineTo(...coords[b]);ctx.stroke();}
  coords.forEach((p,i)=>mark(ctx,p,i));
 }
 function mark(ctx,p,index,teaching=false){
  ctx.beginPath();ctx.arc(...p,index===highlight?10:6,0,Math.PI*2);ctx.fillStyle=index===highlight?'#ff899a':teaching?'#ffc16b':'#7fe5ca';ctx.fill();ctx.strokeStyle='#102029';ctx.lineWidth=2;ctx.stroke();
  ctx.font='bold 13px sans-serif';ctx.lineWidth=3;ctx.strokeStyle='#10151f';ctx.strokeText(String(index+1),p[0]+8,p[1]-7);ctx.fillStyle='#fff';ctx.fillText(String(index+1),p[0]+8,p[1]-7);
 }
 async function drawPhoto(){
  const canvas=$('#pose-photo'),ctx=canvas.getContext('2d');canvas.dataset.ready='false';photoHits=[];ctx.clearRect(0,0,520,420);ctx.fillStyle='#18212e';ctx.fillRect(0,0,520,420);
  const status=$('#pose-photo-point-status');status.textContent='点击编号或照片上的点，查看其对应位置。';
  if(!reference?.url){ctx.fillStyle='#cbd6df';ctx.font='16px sans-serif';ctx.fillText('尚未设置此模板的照片示例',120,200);if(highlight>=0)status.textContent='尚无参考照片，无法显示该点的照片位置。';canvas.dataset.highlightPresent='false';canvas.dataset.ready='true';return;}
  const currentReference=reference,t=state.project.template,root=state.project.root,templateKey=JSON.stringify(t);
  const image=new Image();image.src=currentReference.url;await image.decode();
  if(reference!==currentReference||state.project?.root!==root||JSON.stringify(state.project?.template)!==templateKey)return;
  const scale=Math.min(520/image.naturalWidth,420/image.naturalHeight),x=(520-image.naturalWidth*scale)/2,y=(420-image.naturalHeight*scale)/2;
  ctx.drawImage(image,x,y,image.naturalWidth*scale,image.naturalHeight*scale);
  const points=(reference.annotation?.shapes||[]).filter(s=>s.shape_type==='point').sort((a,b)=>(t.points.indexOf(a.label)===highlight?1:0)-(t.points.indexOf(b.label)===highlight?1:0));
  const groups=new Map();
  for(const shape of points){const index=t.points.indexOf(shape.label);if(index<0||!shape.points?.[0])continue;const p=[x+shape.points[0][0]*scale,y+shape.points[0][1]*scale];photoHits.push({index,p,shape});if(!groups.has(shape.group_id))groups.set(shape.group_id,new Map());groups.get(shape.group_id).set(index,p);}
  ctx.strokeStyle='#72decaaa';ctx.lineWidth=1.5;
  for(const group of groups.values())for(const [a,b] of t.edges||[]){if(!group.has(a)||!group.has(b))continue;ctx.beginPath();ctx.moveTo(...group.get(a));ctx.lineTo(...group.get(b));ctx.stroke();}
  for(const {p,index,shape} of photoHits)mark(ctx,p,index,!!shape.flags?.teaching_reference);
  const chosen=photoHits.find(hit=>hit.index===highlight);canvas.dataset.highlightPresent=String(!!chosen);canvas.dataset.pointCount=String(photoHits.length);
  if(highlight>=0){
   const name=`${highlight+1}. ${t.display?.[highlight]||t.points[highlight]}`;
   status.textContent=chosen?name+'：'+(chosen.shape.flags?.teaching_reference?'橙色为人工教学定位，位置仅作近似解剖参考。':chosen.shape.difficult?'该点被遮挡，显示参考标注位置。':'照片中粉色圆点即该点的对应位置。'):name+'：此照片没有该点坐标，请切换其他示例或设置项目照片；不显示猜测位置。';
   if(chosen){
    const [px,py]=chosen.p;ctx.strokeStyle='#ff899a';ctx.lineWidth=2;ctx.beginPath();ctx.arc(px,py,16,0,Math.PI*2);ctx.stroke();
    ctx.font='bold 14px sans-serif';const width=Math.min(270,ctx.measureText(name).width+20),tx=Math.max(8,Math.min(520-width-8,px+22)),ty=Math.max(42,Math.min(380,py-40));
    ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(tx,ty+14);ctx.stroke();ctx.fillStyle='#10151ff0';ctx.fillRect(tx,ty,width,28);ctx.fillStyle='#fff';ctx.fillText(name,tx+8,ty+19);
   }
  }
  canvas.dataset.ready='true';
 }
 function choosePhotoPoint(index){
  highlight=index;const t=state.project?.template;if(!t)return;
  $('#pose-landmark-detail').textContent=`${index+1}. ${t.display?.[index]||t.points[index]}：${landmarkRule(t.points[index])}`;
  $('#pose-point-legend').querySelectorAll('button').forEach((button,i)=>button.classList.toggle('selected',i===index));drawDiagram();drawPhoto().catch(e=>toast(e.message));
 }
 $('#pose-photo').onclick=event=>{
  const rect=$('#pose-photo').getBoundingClientRect(),p=[(event.clientX-rect.left)*520/rect.width,(event.clientY-rect.top)*420/rect.height];
  const hit=photoHits.map(h=>({...h,distance:Math.hypot(h.p[0]-p[0],h.p[1]-p[1])})).sort((a,b)=>a.distance-b.distance)[0];
  if(hit&&hit.distance<16)choosePhotoPoint(hit.index);
 };
 $('#pose-photo-select').onchange=()=>{reference=photoExamples[Number($('#pose-photo-select').value)]||photoExamples[0];$('#pose-photo-note').textContent=reference.note||'';$('#pose-photo-source').textContent=reference.source||'';drawPhoto().catch(e=>toast(e.message));};
 async function loadReference(options){
  $('#pose-photo').dataset.ready='false';const payload=await api.poseReference(options);photoExamples=payload.examples||[payload];reference=photoExamples[0];
  const select=$('#pose-photo-select');select.replaceChildren();photoExamples.forEach((example,i)=>select.add(new Option(example.title||'项目照片示例',String(i))));select.hidden=photoExamples.length<2;
  $('#pose-photo-note').textContent=reference.note||'';$('#pose-photo-source').textContent=reference.source||'';await drawPhoto();
 }
 async function showGuide(pointIndex){
  if(state.project?.task!=='pose')return;highlight=-1;
  const legend=$('#pose-point-legend');legend.replaceChildren();const t=state.project.template;
  let detail=$('#pose-landmark-detail');if(!detail){detail=document.createElement('p');detail.id='pose-landmark-detail';legend.after(detail);}detail.textContent='选择一个编号，查看该点的定位约定。';
  t.points.forEach((name,i)=>{const button=document.createElement('button');button.textContent=`${i+1}. ${t.display?.[i]||name}`;button.title=name;button.onclick=()=>choosePhotoPoint(i);legend.append(button);});
  const rules=$('#pose-standard');rules.replaceChildren();for(const [title,text] of standard){const section=document.createElement('section'),h=document.createElement('h3'),p=document.createElement('p');h.textContent=title;p.textContent=text;section.append(h,p);rules.append(section);}
  $('#toast').hidden=true;$('#pose-guide-dialog').showModal();drawDiagram();await loadReference();
  if(Number.isInteger(pointIndex)&&pointIndex>=0&&pointIndex<t.points.length){choosePhotoPoint(pointIndex);$('#pose-guide-dialog').scrollTop=0;}
 }
 $('#pose-guide-open').onclick=()=>showGuide(editor.poseTarget()?.index).catch(e=>toast(e.message));
 $('#pose-current-reference').onclick=()=>showGuide(editor.poseTarget()?.index).catch(e=>toast(e.message));
 $('#pose-guide-close').onclick=()=>$('#pose-guide-dialog').close();
 $('#pose-example-builtin').onclick=()=>loadReference({builtin:true}).catch(e=>toast(e.message));
 $('#pose-example-set').onclick=async()=>{try{if(!editor.name){toast('请先在画布打开一张已标注骨点的照片。');return;}await editor.save();await loadReference({name:editor.name});toast('参考照片与骨点快照已保存，重新打开项目仍可查看。');}catch(e){toast(e.message);}};
 if(state.project)refreshSequences().catch(e=>toast(e.message));
})();
