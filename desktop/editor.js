/* Integrated pixel-coordinate editor. No native window or remote service needed. */
(() => {
 const $=s=>document.querySelector(s), clone=v=>structuredClone(v);
 const colors=['#f4b64e','#67cbbb','#a59bff','#ed9cba','#83bcf1','#d3cd75'];
 // Shapes each task may draw. Detection keeps rectangle as the default, with
 // polygon/circle available for round or irregular targets.
 const taskShapeTypes={detect:['rectangle','polygon','rotation','circle'],segment:['polygon','brush','circle'],pose:['rectangle'],obb:['rotation'],classify:[]};
 const shapeNames={rectangle:'矩形框',polygon:'多边形',circle:'圆形/椭圆',rotation:'旋转框',brush:'画笔',point:'关键点'};
 // A round mark is stored as [centre, [horizontal radius, vertical radius]].
 // [centre, edge] is the older two-point form (a circle, or an axis-aligned
 // ellipse through that corner); it is still read so existing labels open fine.
 const circlePoints=(center,edge,count=32)=>{
  const [rx,ry]=Array.isArray(edge)?[Math.abs(edge[0])||1,Math.abs(edge[1])||1]:[Math.abs(edge[0]-center[0])||1,Math.abs(edge[1]-center[1])||1];
  const p=[];for(let i=0;i<count;i++){const a=i/count*Math.PI*2;p.push([center[0]+Math.cos(a)*rx,center[1]+Math.sin(a)*ry]);}
  return p;
 };
 // Read the two radii out of either stored form.
 const circleRadii=points=>{
  if(points.length>=3&&Array.isArray(points[1]))return [Math.abs(points[1][0])||1,Math.abs(points[1][1])||1];
  const center=points[0],edge=points[1]||[center[0]+1,center[1]+1];
  return [Math.abs(edge[0]-center[0])||1,Math.abs(edge[1]-center[1])||1];
 };
 const circleRing=(points,count=32)=>circlePoints(points[0],circleRadii(points),count);
 const rect=(a,b)=>[[Math.min(a[0],b[0]),Math.min(a[1],b[1])],[Math.max(a[0],b[0]),Math.min(a[1],b[1])],[Math.max(a[0],b[0]),Math.max(a[1],b[1])],[Math.min(a[0],b[0]),Math.max(a[1],b[1])]];
 const inside=(p,points)=>{let hit=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;};
 class AnnotationEditor {
  constructor(callbacks){
   this.callbacks=callbacks;this.canvas=$('#annotation-canvas');this.ctx=this.canvas.getContext('2d');
   this.data=null;this.image=null;this.name=null;this.project=null;this.dirty=false;this.selected=-1;this.activeClass='';this.mode='draw';this.history=[];this.future=[];this.pending=[];this.pose=null;this.drag=null;this.zoom=1;this.offset=[0,0];this.baseHash=null;this.saving=null;this.loadToken=0;this.imageCache=new Map();this.requestedName=null;this.loadingName=null;this.opening=null;this.confirming=null;this.approving=null;this.shapeType='rectangle';this.brush=[];this.selectedMany=[];this.marquee=null;this.finalizing=false;this.suppressContextMenu=false;this.circleArming=false;this.circleBase=8;
   const placement=document.createElement('select');placement.id='pose-placement';placement.setAttribute('aria-label','姿态放置方式');
   placement.add(new Option('模板放置','template'));placement.add(new Option('顺序点选','sequence'));
   const placementRow=document.createElement('label');placementRow.className='pose-placement-row';const placementLabel=document.createElement('span');placementLabel.textContent='放置方式';placementRow.append(placementLabel,placement);$('#pose-controls').insertBefore(placementRow,$('#pose-progress'));
   placement.onchange=()=>{this.rememberPreferences();this.hint();};
   const notice=document.createElement('p');notice.id='dirty-notice';notice.className='dirty-notice';notice.hidden=true;notice.textContent='有未保存的修改 · S / Ctrl+S 保存并审核，或点“保存，下一张”';notice.onclick=()=>this.approve();
   $('.canvas-area')?.append(notice);
   new ResizeObserver(()=>this.fit()).observe($('#canvas-host'));
   this.canvas.addEventListener('pointerdown',e=>this.down(e));this.canvas.addEventListener('pointermove',e=>this.move(e));this.canvas.addEventListener('pointerup',e=>this.up(e));this.canvas.addEventListener('pointercancel',()=>this.cancelDrag());
   this.canvas.addEventListener('pointerleave',()=>this.leavePosePoint());
   // Right-click still closes an open contour; when the right button was used to
   // drag a selection box instead, the menu is simply suppressed.
   this.canvas.addEventListener('dblclick',()=>this.finishPolygon());this.canvas.addEventListener('contextmenu',e=>{e.preventDefault();if(this.suppressContextMenu){this.suppressContextMenu=false;return;}this.finishPolygon();});
   this.canvas.addEventListener('wheel',e=>this.wheel(e),{passive:false});
   // Capture this app shortcut before focused controls or bubbling handlers.
   document.addEventListener('keydown',e=>{
    if(!e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.isComposing&&e.key.toLowerCase()==='e'&&this.callbacks.isEditor()&&!document.querySelector('dialog[open]')){
     const typing=e.target.isContentEditable||e.target.tagName==='TEXTAREA'||e.target.tagName==='INPUT'&&!['checkbox','radio','button'].includes(e.target.type);
     if(!typing){e.stopImmediatePropagation();this.key(e);}
    }
   },true);
   document.addEventListener('keydown',e=>this.key(e));
   $('#tool-select').onclick=()=>this.setMode('select');$('#tool-draw').onclick=()=>{if(this.project?.task==='classify')this.classify();else this.setMode('draw');};
   $('#finish-polygon').onclick=()=>this.finishPolygon();$('#undo').onclick=()=>this.undo();$('#redo').onclick=()=>this.redo();$('#fit-image').onclick=()=>this.fit();
   $('#delete-shape').onclick=()=>this.remove();$('#relabel-selected').onclick=()=>this.relabel();
   const marqueeButton=$('#marquee-delete');
   if(marqueeButton)marqueeButton.onclick=()=>{
    if(this.selectedMany.length)this.removeSelectedMany();
    else this.callbacks.toast('按住 Shift 在画布上拖出一个方框，框到的对象会被选中，再按 Delete 或点这里删除。');
   };
   $('#active-class').onchange=e=>this.chooseClass(e.target.value);
   this.nextOccluded=false;this.mirrorX=false;this.mirrorY=false;
   $('#skip-point').onclick=()=>this.skipPoint();$('#occluded').onchange=()=>this.setOccluded($('#occluded').checked);
   $('#object-occluded').onchange=()=>this.setObjectOccluded($('#object-occluded').checked);
   $('#mirror-pose').onclick=()=>this.mirrorPose('x');$('#flip-pose').onclick=()=>this.mirrorPose('y');
   for(const [id,key] of [['#template-mirror','mirrorX'],['#template-flip','mirrorY']])$(id).onchange=()=>{this[key]=$(id).checked;this.rememberPreferences();};
   $('#save-annotation').onclick=()=>this.approve();
   $('#approve-annotation').onclick=()=>this.approve();$('#accept-candidate').onclick=()=>this.accept();
  }
  setProject(project){
   const changedProject=this.project?.root!==project?.root;
   if(changedProject){this.imageCache?.clear();this.loadToken++;this.requestedName=null;this.loadingName=null;this.name=null;this.data=null;this.image=null;this.dirty=false;this.pending=[];this.pose=null;this.history=[];this.future=[];this.selected=-1;}
   this.project=project;if(changedProject){this.nextOccluded=false;this.restorePreferences();}
   const choices=$('#active-class');if([...choices.options].map(o=>o.value).join('\n')!==(project?.classes||[]).join('\n')){choices.replaceChildren();for(const c of project?.classes||[])choices.add(new Option(c,c));}
   if(!project?.classes.includes(this.activeClass))this.activeClass=project?.classes[0]||'';choices.value=this.activeClass;
   this.classButtons();
   this.shapeButtons();
   $('#active-class').parentElement.querySelector('p').textContent=project?.task==='pose'?'每个对象单独选择姿态类别，例如站立、趴卧。同一张图可标注多种姿态。':project?.task==='classify'?'分类任务为整张图片选择一个类别。':'同一张图可标注多个不同类别。先选类别，再画对应对象。';
   $('#pose-controls').hidden=project?.task!=='pose';
   $('#tool-draw').innerHTML=(window.workflowIcon?.(project?.task)||'')+({detect:'矩形框',segment:'多边形',pose:'姿态实例',obb:'旋转框',classify:'应用当前类别'}[project?.task]||'画框');
   if(changedProject)this.setMode(this.preferences?.mode||'draw',false);
   this.render();this.list();this.hint();
  }
  // Shape buttons appear only when the task allows more than one shape, so a
  // detection project can draw boxes, polygons or circles without switching task.
  shapeButtons(){
   const allowed=this.allowedShapes();
   let bar=$('#shape-switch');
   if(!bar){bar=document.createElement('div');bar.id='shape-switch';bar.className='shape-switch';$('#tool-draw').after(bar);}
   bar.replaceChildren();
   bar.hidden=allowed.length<2;
   if(allowed.length<2)return;
   if(!allowed.includes(this.shapeType))this.shapeType=allowed[0];
   for(const kind of allowed){
    const button=document.createElement('button');button.type='button';button.dataset.shape=kind;
    button.textContent=shapeNames[kind]||kind;button.title='当前画图工具：'+(shapeNames[kind]||kind);
    button.className=kind===this.shapeType?'selected':'';
    button.onclick=()=>{this.shapeType=kind;this.setMode('draw');this.shapeButtons();this.hint();};
    bar.append(button);
   }
  }
  classButtons(){
   let bar=$('#class-shortcuts');if(!bar){bar=document.createElement('div');bar.id='class-shortcuts';$('#active-class').after(bar);}
   const classes=this.project?.classes||[];$('#active-class').hidden=classes.length>0&&classes.length<=9;bar.hidden=classes.length>9;bar.dataset.count=String(classes.length);
   bar.replaceChildren();if(classes.length>9)return;
   for(const [index,name] of classes.entries()){
    const button=document.createElement('button');button.type='button';button.title=name;button.setAttribute('aria-pressed',String(name===this.activeClass));button.className=name===this.activeClass?'selected':'';
    const number=document.createElement('small');number.textContent=String(index+1);const label=document.createElement('span');label.textContent=name;button.append(number,label);
    button.onclick=()=>this.chooseClass(name);bar.append(button);
   }
  }
  rememberPreferences(patch={}){
   if(!this.project?.root)return;
   this.preferences={...this.preferences,activeClass:this.activeClass,placement:$('#pose-placement').value,mirrorX:!!this.mirrorX,mirrorY:!!this.mirrorY,shapeType:this.shapeType,...patch};
   try{window.localStorage.setItem('annotation-workbench:editor:'+this.project.root,JSON.stringify(this.preferences));}catch{}
  }
  restorePreferences(){
   let saved={};try{saved=JSON.parse(window.localStorage.getItem('annotation-workbench:editor:'+this.project.root)||'{}')||{};}catch{}
   if(typeof saved!=='object'||Array.isArray(saved))saved={};
   this.preferences={...saved,mode:['draw','select'].includes(saved.mode)?saved.mode:'draw'};
   this.mirrorX=saved.mirrorX===true;this.mirrorY=saved.mirrorY===true;$('#template-mirror').checked=this.mirrorX;$('#template-flip').checked=this.mirrorY;
   $('#pose-placement').value=saved.placement==='sequence'?'sequence':'template';
   this.activeClass=this.project?.classes.includes(saved.activeClass)?saved.activeClass:this.project?.classes[0]||'';
   if(this.allowedShapes().includes(saved.shapeType))this.shapeType=saved.shapeType;
  }
  chooseClass(name){
   if(!this.project?.classes.includes(name))return;
   this.activeClass=name;$('#active-class').value=name;this.classButtons();this.rememberPreferences();
   if(this.project.task==='classify')this.classify();else{this.hint();this.render();}
  }
  open(name){
   this.requestedName=name;this.loadToken++;
   if(this.opening)return this.opening;
   let operation;
   operation=Promise.resolve().then(async()=>{
    while(this.requestedName){
     const target=this.requestedName,token=this.loadToken,root=this.project?.root;
     this.loadingName=target;this.status();
     try{
      await this.settleEdits();
      if(token!==this.loadToken)continue;
      if(root!==this.project?.root)return false;
      if(this.name===target&&this.image){this.requestedName=null;return true;}
      const label=await this.callbacks.rpc('load_annotation',{name:target});
      if(token!==this.loadToken)continue;
      if(!label)throw new Error('无法读取图片标注，请刷新列表后重试。');
      const image=await this.prefetchImage(target);
      if(token!==this.loadToken)continue;
      // Edits made on the still-visible old image are saved before committing the replacement.
      await this.settleEdits();
      if(token!==this.loadToken)continue;
      if(root!==this.project?.root)return false;
      this.name=target;this.image=image;this.data=clone(label.annotation||{shapes:[],flags:{}});this.data.shapes??=[];this.data.flags??={};
      this.nextOccluded=false;this.baseHash=label.base_hash;this.proposal=label.proposal;this.selected=-1;this.dirty=false;this.pending=[];this.pose=null;this.history=[];this.future=[];
      this.selectedMany=[];this.setMode(this.preferences?.mode||'draw',false);
      $('#image-name').textContent=target;$('#canvas-empty').hidden=true;
      if(this.project.task==='classify'){const c=this.project.classes.find(c=>this.data.flags[c]);if(c){this.activeClass=c;$('#active-class').value=c;}}
      this.requestedName=null;this.fit();this.list();this.status();this.hint();this.candidate();return true;
     }catch(error){if(token!==this.loadToken)continue;this.requestedName=null;throw error;}
    }
    return false;
   }).finally(()=>{if(this.opening===operation)this.opening=null;this.loadingName=null;this.status();});
   this.opening=operation;return operation;
  }
  prefetchImage(name){
   this.imageCache??=new Map();const key=this.project?.root+'|'+name;
   if(!this.imageCache.has(key)){
    const promise=window.workbench.asset(name).then(async asset=>{const image=new Image();image.src=asset.url;await image.decode();return image;}).catch(error=>{this.imageCache.delete(key);throw error;});
    this.imageCache.set(key,promise);
    while(this.imageCache.size>4)this.imageCache.delete(this.imageCache.keys().next().value);
   }
   return this.imageCache.get(key);
  }
  // Drop the current picture without touching the files (used when it is removed
  // from the dataset). Bumping the token also cancels an in-flight open.
  forget(){
   this.loadToken++;this.requestedName=null;this.loadingName=null;
   this.name=null;this.image=null;this.data=null;this.proposal=null;this.baseHash=null;
   this.dirty=false;this.selected=-1;this.selectedMany=[];this.pending=[];this.brush=[];
   this.pose=null;this.history=[];this.future=[];this.marquee=null;this.finalizing=false;this.circleArming=false;
   $('#image-name').textContent='';$('#canvas-empty').hidden=false;
   this.list();this.status();this.hint();this.render();
  }
  snapshot(){return {annotation:clone(this.data),pose:clone(this.pose),nextOccluded:!!this.nextOccluded};}
  restore(snapshot){this.data=snapshot.annotation;this.pose=snapshot.pose;this.nextOccluded=snapshot.nextOccluded;this.selected=-1;this.selectedMany=[];}
  checkpoint(){this.history.push(this.snapshot());if(this.history.length>60)this.history.shift();this.future=[];}
  changed(){this.dirty=true;this.data.checked=false;this.render();this.list();this.status();this.hint();}
  undo(){if(this.pending.length){this.pending.pop();this.render();return;}if(!this.history.length||!this.data)return;this.future.push(this.snapshot());this.restore(this.history.pop());this.changed();}
  redo(){if(!this.future.length||!this.data)return;this.history.push(this.snapshot());this.restore(this.future.pop());this.changed();}
  status(){for(const id of ['#save-annotation','#approve-annotation'])$(id).disabled=!!(this.saving||this.confirming||this.approving);$('#save-status').textContent=this.saving?'正在保存…':this.loadingName?'正在切换图片，保留当前画面…':this.dirty?'未保存的修改':this.data?.checked?'已保存 · 已审核':this.name?'已保存 · 待审核':'尚未编辑';$('#undo').disabled=!this.history.length&&!this.pending.length;$('#redo').disabled=!this.future.length;const notice=$('#dirty-notice');if(notice)notice.hidden=!this.dirty;}
  setMode(mode,persist=true){this.mode=mode;this.pending=[];this.circleArming=false;this.pose=null;this.drag=null;if(persist)this.rememberPreferences({mode});$('#tool-select').classList.toggle('selected',mode==='select');$('#tool-draw').classList.toggle('selected',mode==='draw');this.canvas.style.cursor=mode==='select'?'default':'crosshair';this.hint();this.render();}
  hint(){
   let text={detect:'拖动画框 · V 选择与拖动 · 滚轮缩放 · 中键平移',segment:'点击添加顶点 · Enter/双击完成 · Esc 取消 · V 微调',pose:'先拖出对象框，放置骨点后拖动微调',obb:'拖出矩形，选择后拖动上方旋转手柄 · V 微调',classify:'选择类别并点击应用，或按数字 1–9 设置整图类别'}[this.project?.task]||'选择一张图片开始标注';
   const kind=this.defaultShape();
   if(this.mode==='draw'){
    if(kind==='polygon')text='逐点点击勾画轮廓，点多少下都行 · 结束时：点回第一个点 / 双击 / Enter / 右键 · 结束前只是虚线草稿';
    else if(kind==='circle')text='第 1 步：点一下确定圆心 · 第 2 步：移动鼠标调高矮胖瘦（或按 ↑↓←→），再点一下确定';
    else if(kind==='brush')text='按住鼠标左键并移动即可涂画轮廓 · 松开完成 · 适合快速圈出不规则目标';
    else if(kind==='rectangle')text='拖动画矩形框 · 拖动已有顶点可直接改框 · Q 切换标签';
    else if(kind==='rotation')text='拖出矩形，选择后拖动上方旋转手柄调整方向';
   }
   if(this.pose){const t=this.project.template;text='点击骨点 '+(this.pose.index+1)+' / '+t.points.length+'：'+(t.display||t.points)[this.pose.index];}
   $('#tool-hint').textContent=text;
   $('#shortcut-hint').textContent='A/D 切图 · Enter 审核 · S 保存 · Q 下个标签 · Shift+Q 上个标签 · V 选择 / R 画图 · Ctrl+Z 撤销';
   // The button stays available whenever a contour is open so it cannot be missed.
   const finish=$('#finish-polygon');
   if(finish){
    const open=this.pending.length>0&&this.defaultShape()==='polygon';
    finish.hidden=!open;
    finish.textContent=open?('完成轮廓（'+this.pending.length+' 点）'):'完成轮廓';
    finish.disabled=this.pending.length<2;
   }
   const point=this.data?.shapes[this.selected];
   $('#occluded').checked=point?.shape_type==='point'?!!point.difficult:!!this.nextOccluded;
   $('#occluded').disabled=point?.shape_type!=='point'&&!this.pose;
   this.syncObjectOcclusion();
   $('#skip-point').disabled=point?.shape_type!=='point'&&!this.pose;
   const target=this.poseTarget();
   $('#pose-phase').textContent=point?.shape_type==='point'?'正在微调':this.pose?'下一骨点':'准备标注';
   $('#pose-point-name').textContent=target?.name||'画框开始标注';
   $('#pose-point-count').textContent=target?(target.index+1)+' / '+this.project.template.points.length:this.project?.template?.points.length?this.project.template.points.length+' 点模板':'';
   $('#pose-current-reference').disabled=!target;
   $('#pose-next-hint').textContent=point?.shape_type==='point'&&this.pose?'下一点：'+(this.project.template.display||this.project.template.points)[this.pose.index]:this.pose?'在照片上点击该位置，或按 K 跳过。':'放置方式与模板方向会自动记住。';
   $('#skip-point-label').textContent=point?.shape_type==='point'?'设为未知':'跳过此点';
  }
  poseTarget(){
   const t=this.project?.template;if(this.project?.task!=='pose'||!t)return null;
   const selected=this.data?.shapes[this.selected];const index=selected?.shape_type==='point'?t.points.indexOf(selected.label):this.pose?.index;
   if(!Number.isInteger(index)||index<0||index>=t.points.length)return null;
   return {index,name:t.display?.[index]||t.points[index]};
  }
  syncPosePointer(index=-1){
   // During sequential placement, an existing point owns the inspector only
   // while hovered or dragged. Leaving it restores the next placement task.
   if(!this.pose||this.drag||this.marquee)return;
   const next=this.data?.shapes[index]?.shape_type==='point'?index:-1;
   if(next===this.selected)return;
   this.selected=next;this.selectedMany=[];this.lastVertex=null;
   this.hint();this.list();this.render();
  }
  leavePosePoint(){
   if(this.drag)return;
   this.hover=null;this.lastVertex=null;this.canvas.title='';this.syncPosePointer();
  }
  fit(){
   const r=$('#canvas-host').getBoundingClientRect();if(!r.width||!r.height)return;
   const dpr=devicePixelRatio||1,width=Math.round(r.width*dpr),height=Math.round(r.height*dpr);if(this.canvas.width!==width)this.canvas.width=width;if(this.canvas.height!==height)this.canvas.height=height;
   this.size=[r.width,r.height];if(this.image){this.zoom=Math.min((r.width-46)/this.image.naturalWidth,(r.height-46)/this.image.naturalHeight);this.offset=[(r.width-this.image.naturalWidth*this.zoom)/2,(r.height-this.image.naturalHeight*this.zoom)/2];}
   this.render();
  }
  toImage(e){const r=this.canvas.getBoundingClientRect();return [(e.clientX-r.left-this.offset[0])/this.zoom,(e.clientY-r.top-this.offset[1])/this.zoom];}
  clamp(p){return [Math.max(0,Math.min(this.image.naturalWidth,p[0])),Math.max(0,Math.min(this.image.naturalHeight,p[1]))];}
  onImage(p){return this.image&&p[0]>=0&&p[1]>=0&&p[0]<=this.image.naturalWidth&&p[1]<=this.image.naturalHeight;}
  color(s){const object=s.shape_type==='point'?this.data?.shapes.find(item=>item.shape_type==='rectangle'&&item.group_id===s.group_id):s;return colors[Math.max(0,this.project?.classes.indexOf(object?.label||s.label)||0)%colors.length];}
  displayLabel(s){if(s.shape_type==='point'&&this.project?.template){const t=this.project.template,index=t.points.indexOf(s.label);return t.display?.[index]||s.label;}return s.label+(s.flags?.occluded?' · 遮挡':'');}
  // Only pose objects need an instance number (a box plus its keypoints share a
  // group). Detection and segmentation labels are just the class name; showing
  // "· 实例 0" there reads like a different kind of label.
  suffix(s){return this.project?.task==='pose'&&s.group_id!=null?(' · 实例 '+s.group_id):'';}
  // Which shapes the active task may hold. Detection also accepts polygons and
  // circles because users asked to mark round or irregular targets; those are
  // exported as boxes/circles when building the dataset.
  allowedShapes(){return (taskShapeTypes[this.project?.task]||['rectangle']);}
  defaultShape(){const allowed=this.allowedShapes();return allowed.includes(this.shapeType)?this.shapeType:allowed[0];}
  drawShape(){return this.mode==='draw'?this.defaultShape():null;}
  render(){
   // Safety net: never paint a contour that is not in the data. Points stay put
   // while the user is still drawing, so this only fires if a save left something
   // stranded; it commits them instead of discarding, because the outline is
   // already visible on screen.
   if(this.data&&this.finalizing&&this.pending.length>=2&&!this.drag&&this.defaultShape()==='polygon'){
    const points=this.pending.slice();this.pending=[];
    this.checkpoint();
    this.data.shapes.push(this.makeShape(this.activeClass,'rectangle',rect(points[0],points[points.length-1])));
    this.selected=this.data.shapes.length-1;
    this.dirty=true;this.data.checked=false;
   }
   const ctx=this.ctx,dpr=devicePixelRatio||1;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,this.canvas.width/dpr,this.canvas.height/dpr);
   if(!this.image||!this.data){$('#canvas-empty').hidden=false;return;}
   ctx.save();ctx.translate(...this.offset);ctx.scale(this.zoom,this.zoom);ctx.drawImage(this.image,0,0);
   const draw=(s,index,candidate=false)=>{
    const p=s.points;if(!p?.length)return;const color=candidate?'#f5bc60':this.color(s);ctx.lineWidth=(index===this.selected?2.5:1.5)/this.zoom;ctx.strokeStyle=color;ctx.fillStyle=color+'22';ctx.setLineDash(candidate?[7/this.zoom,5/this.zoom]:[]);
    if(s.shape_type==='point'){ctx.beginPath();ctx.arc(p[0][0],p[0][1],5/this.zoom,0,Math.PI*2);ctx.fillStyle=s.difficult?'#10151f':color;ctx.fill();ctx.strokeStyle=s.difficult?color:'#10151f';ctx.lineWidth=(s.difficult?2:1)/this.zoom;ctx.stroke();if(s.difficult){ctx.beginPath();ctx.moveTo(p[0][0]-2/this.zoom,p[0][1]-2/this.zoom);ctx.lineTo(p[0][0]+2/this.zoom,p[0][1]+2/this.zoom);ctx.moveTo(p[0][0]-2/this.zoom,p[0][1]+2/this.zoom);ctx.lineTo(p[0][0]+2/this.zoom,p[0][1]-2/this.zoom);ctx.stroke();}}
    else if(s.shape_type==='circle'&&p.length>=2){const ring=circleRing(p);ctx.beginPath();ring.forEach((v,i)=>i?ctx.lineTo(...v):ctx.moveTo(...v));ctx.closePath();ctx.fill();ctx.stroke();
     const [,ry]=circleRadii(p);
     ctx.setLineDash([]);const label=this.displayLabel(s)+this.suffix(s);ctx.font=(11/this.zoom)+'px "Microsoft YaHei UI","Workbench Sans",sans-serif';const w=ctx.measureText(label).width;ctx.fillStyle='#10151fe8';const y=Math.max(0,p[0][1]-ry-20/this.zoom);ctx.fillRect(p[0][0]-w/2,y,w+10/this.zoom,19/this.zoom);ctx.fillStyle=color;ctx.fillText(label,p[0][0]-w/2+5/this.zoom,y+13/this.zoom);
    }
    else{ctx.beginPath();p.forEach((v,i)=>i?ctx.lineTo(...v):ctx.moveTo(...v));ctx.closePath();ctx.fill();ctx.stroke();
     ctx.setLineDash([]);const label=this.displayLabel(s)+this.suffix(s);ctx.font=(11/this.zoom)+'px "Microsoft YaHei UI","Workbench Sans",sans-serif';const w=ctx.measureText(label).width;ctx.fillStyle='#10151fe8';const y=Math.max(0,p[0][1]-20/this.zoom);ctx.fillRect(p[0][0],y,w+10/this.zoom,19/this.zoom);ctx.fillStyle=color;ctx.fillText(label,p[0][0]+5/this.zoom,y+13/this.zoom);
    }
    if(index===this.selected&&!candidate){ctx.setLineDash([]);ctx.fillStyle='#ffffff';ctx.strokeStyle=color;for(const v of p){ctx.fillRect(v[0]-3/this.zoom,v[1]-3/this.zoom,6/this.zoom,6/this.zoom);ctx.strokeRect(v[0]-3/this.zoom,v[1]-3/this.zoom,6/this.zoom,6/this.zoom);}if(this.lastVertex!=null&&p[this.lastVertex]){const hv=p[this.lastVertex];ctx.fillStyle='#ff7a7a';ctx.fillRect(hv[0]-4.5/this.zoom,hv[1]-4.5/this.zoom,9/this.zoom,9/this.zoom);}
     if(s.shape_type==='rotation'){const h=this.rotationHandle(s),m=[(p[0][0]+p[1][0])/2,(p[0][1]+p[1][1])/2];ctx.beginPath();ctx.moveTo(...m);ctx.lineTo(...h);ctx.stroke();ctx.beginPath();ctx.arc(...h,5/this.zoom,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();}}
   };
   this.data.shapes.forEach((s,i)=>draw(s,i));if(this.proposal)this.proposal.annotation.shapes.forEach(s=>draw(s,-2,true));
   if(this.project.task==='pose'){const t=this.project.template;const groups=new Map();for(const s of this.data.shapes)if(s.shape_type==='point'){if(!groups.has(s.group_id))groups.set(s.group_id,{});groups.get(s.group_id)[s.label]=s.points[0];}
    ctx.lineWidth=1.7/this.zoom;ctx.setLineDash([]);for(const [group,pts] of groups){ctx.strokeStyle=this.color(this.data.shapes.find(s=>s.shape_type==='rectangle'&&s.group_id===group)||{label:''});for(const [a,b] of t.edges||[]){const x=pts[t.points[a]],y=pts[t.points[b]];if(x&&y){ctx.beginPath();ctx.moveTo(...x);ctx.lineTo(...y);ctx.stroke();}}}}
   if(this.pending.length){
    if(this.defaultShape()==='circle'&&this.pending.length>=2){
     // Live preview of the round mark plus its width/height handles.
     const center=this.pending[0],radii=this.pending[1],ring=circlePoints(center,radii);
     ctx.setLineDash([5/this.zoom,4/this.zoom]);ctx.lineWidth=2/this.zoom;ctx.strokeStyle='#ffd687';
     ctx.beginPath();ring.forEach((v,i)=>i?ctx.lineTo(...v):ctx.moveTo(...v));ctx.closePath();ctx.stroke();
     ctx.setLineDash([]);ctx.strokeStyle='#8fd3ff';ctx.lineWidth=1.4/this.zoom;
     ctx.beginPath();ctx.moveTo(center[0]-radii[0],center[1]);ctx.lineTo(center[0]+radii[0],center[1]);ctx.moveTo(center[0],center[1]-radii[1]);ctx.lineTo(center[0],center[1]+radii[1]);ctx.stroke();
     ctx.fillStyle='#8fd3ff';
     for(const handle of [[center[0]+radii[0],center[1]],[center[0],center[1]-radii[1]],[center[0],center[1]+radii[1]]]){ctx.beginPath();ctx.arc(handle[0],handle[1],4/this.zoom,0,Math.PI*2);ctx.fill();}
     ctx.fillStyle='#ffd687';ctx.beginPath();ctx.arc(center[0],center[1],3.5/this.zoom,0,Math.PI*2);ctx.fill();
    }else{
     ctx.strokeStyle='#ffd687';ctx.lineWidth=2/this.zoom;ctx.setLineDash([4/this.zoom,3/this.zoom]);ctx.beginPath();this.pending.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));if(this.hover)ctx.lineTo(...this.hover);ctx.stroke();ctx.setLineDash([]);
     if(this.defaultShape()==='circle'){ctx.fillStyle='#ffd687';ctx.beginPath();ctx.arc(this.pending[0][0],this.pending[0][1],4/this.zoom,0,Math.PI*2);ctx.fill();}
    }
   }
   if(this.brush.length){ctx.strokeStyle='#ffd687';ctx.lineWidth=2/this.zoom;ctx.setLineDash([]);ctx.beginPath();this.brush.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.stroke();}
   // Show every object picked up by a marquee so the user can see what will go.
   if(this.selectedMany.length){
    ctx.setLineDash([]);ctx.lineWidth=2.5/this.zoom;ctx.strokeStyle='#ff5f6d';
    for(const index of this.selectedMany){
     const shape=this.data.shapes[index];if(!shape)continue;
     const [x1,y1,x2,y2]=this.shapeBox(shape);
     ctx.strokeRect(x1,y1,x2-x1,y2-y1);
    }
   }
   if(this.marquee){
    const box=rect(this.marquee.start,this.marquee.end),a=box[0],b=box[2];
    ctx.setLineDash([6/this.zoom,4/this.zoom]);ctx.lineWidth=1.5/this.zoom;ctx.strokeStyle='#8fd3ff';
    ctx.fillStyle='#8fd3ff22';ctx.fillRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);ctx.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);
    ctx.setLineDash([]);
   }
   if(this.drag?.kind==='new'){const kind=this.drag.shape||'rectangle';const pts=kind==='circle'?circlePoints(this.drag.start,this.drag.end):rect(this.drag.start,this.drag.end);draw({points:pts,label:this.activeClass,shape_type:'polygon'},-1);}
   if(this.project.task==='classify'){const name=this.project.classes.find(c=>this.data.flags[c]);if(name){ctx.font=(16/this.zoom)+'px "Microsoft YaHei UI"';ctx.fillStyle='#10151feb';ctx.fillRect(0,0,ctx.measureText(name+(this.data.occluded?' · 遮挡':'')).width+30/this.zoom,36/this.zoom);ctx.fillStyle='#f6c66b';ctx.fillText(name+(this.data.occluded?' · 遮挡':''),12/this.zoom,24/this.zoom);}}
   ctx.restore();$('#zoom-value').textContent=Math.round(this.zoom*100)+'%';
  }
  // The rotation grip floats just outside the box, pointing away from its centre.
  // When the box hugs the picture edge that direction would put the grip on the
  // margin *outside* the canvas, where clicks never reach it and the box could not
  // be turned at all; it is flipped inward instead so it stays grabbable.
  rotationHandle(s){
   const p=s.points,m=[(p[0][0]+p[1][0])/2,(p[0][1]+p[1][1])/2],c=p.reduce((a,v)=>[a[0]+v[0]/4,a[1]+v[1]/4],[0,0]);
   let dx=m[0]-c[0],dy=m[1]-c[1];const d=Math.hypot(dx,dy)||1;dx/=d;dy/=d;
   const distance=25/this.zoom;
   let hx=m[0]+dx*distance,hy=m[1]+dy*distance;
   const [width,height]=this.size||[0,0];
   if(width&&height){
    const screenX=this.offset[0]+hx*this.zoom,screenY=this.offset[1]+hy*this.zoom;
    if(screenX<6||screenX>width-6||screenY<6||screenY>height-6){hx=m[0]-dx*distance;hy=m[1]-dy*distance;}
   }
   return [hx,hy];
  }
  // Index of the rotation shape whose handle is under ``p`` (topmost first).
  rotationHandleIndex(p){
   const radius=12/this.zoom;
   for(let i=this.data.shapes.length-1;i>=0;i--){
    const shape=this.data.shapes[i];
    if(shape.shape_type!=='rotation')continue;
    const handle=this.rotationHandle(shape);
    if(Math.hypot(p[0]-handle[0],p[1]-handle[1])<radius)return i;
   }
   return -1;
  }
  rotationHandleHit(p){return this.rotationHandleIndex(p)>=0;}
  // Nearest draggable handle on any existing shape, searched newest-first so the
  // topmost object wins the grab.
  grabHandle(p){   const hitRadius=10/this.zoom;
   for(let i=this.data.shapes.length-1;i>=0;i--){
    const shape=this.data.shapes[i];
    if(shape.shape_type==='rotation'){
     const handle=this.rotationHandle(shape);
     if(Math.hypot(p[0]-handle[0],p[1]-handle[1])<hitRadius)return {index:i,kind:'rotate',vertex:0};
    }
    for(let v=0;v<shape.points.length;v++){
     if(Math.hypot(p[0]-shape.points[v][0],p[1]-shape.points[v][1])<hitRadius)return {index:i,kind:'vertex',vertex:v};
    }
   }
   return null;
  }
  hitShape(p){
   const radius=6/this.zoom;
   for(let i=this.data.shapes.length-1;i>=0;i--){
    const shape=this.data.shapes[i],points=shape.points;
    if(shape.shape_type==='point'){
     if(Math.hypot(p[0]-points[0][0],p[1]-points[0][1])<10/this.zoom)return i;
    }else if(shape.shape_type==='circle'){
     const c=points[0],[rx,ry]=circleRadii(points);
     if(((p[0]-c[0])/rx)**2+((p[1]-c[1])/ry)**2<=1)return i;
    }else{
     if(inside(p,points))return i;
     // Include the visible stroke on every edge, even when half of it lies
     // outside the image. Ray casting alone excludes right/bottom boundaries.
     for(let j=0;j<points.length;j++){
      const a=points[j],b=points[(j+1)%points.length],dx=b[0]-a[0],dy=b[1]-a[1];
      const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
      if(Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)<=radius)return i;
     }
    }
   }
   return -1;
  }
  // Bounding box of any shape type, including the two-point circle.
  shapeBox(shape){
   const points=shape.shape_type==='circle'?circleRing(shape.points,12):shape.points;
   const xs=points.map(point=>point[0]),ys=points.map(point=>point[1]);
   return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
  }
  shapesInBox(a,b){
   const left=Math.min(a[0],b[0]),top=Math.min(a[1],b[1]),right=Math.max(a[0],b[0]),bottom=Math.max(a[1],b[1]);
   const hits=[];
   (this.data?.shapes||[]).forEach((shape,index)=>{
    const [x1,y1,x2,y2]=this.shapeBox(shape);
    if(x2>=left&&x1<=right&&y2>=top&&y1<=bottom)hits.push(index);
   });
   return hits;
  }
  selectMany(indexes){
   this.selectedMany=[...new Set(indexes)].sort((a,b)=>a-b);
   this.selected=this.selectedMany.length?this.selectedMany[this.selectedMany.length-1]:-1;
  }
  isMultiSelected(index){return this.selectedMany.includes(index);}
  removeSelectedMany(){
   const indexes=this.selectedMany.filter(index=>index>=0&&index<this.data.shapes.length);
   if(!indexes.length)return false;
   this.checkpoint();
   if(this.project.task==='pose'){
    // Deleting a pose box must take its keypoints with it.
    const groups=new Set(indexes.map(index=>this.data.shapes[index].group_id).filter(id=>id!=null));
    const boxes=indexes.map(index=>this.data.shapes[index]).filter(shape=>shape.shape_type==='rectangle');
    boxes.forEach(shape=>groups.add(shape.group_id));
    this.data.shapes=this.data.shapes.filter(shape=>!groups.has(shape.group_id));
   }else{
    const drop=new Set(indexes);
    this.data.shapes=this.data.shapes.filter((_,index)=>!drop.has(index));
   }
   this.selectMany([]);this.changed();
   this.callbacks.toast('已删除 '+indexes.length+' 个对象。');
   return true;
  }
  down(e){
   if(!this.image||!this.data)return;const p=this.toImage(e);this.canvas.focus();
   // Right button always draws a selection box, in either mode. In select mode it
   // is the natural "grab a group" gesture, and it cannot clash with drawing or
   // with dragging an object.
   if(e.button===2){
    e.preventDefault();
    this.marquee={start:p,end:p};this.selectMany([]);
    if(this.canvas.setPointerCapture)this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor='crosshair';this.hint();this.render();return;
   }
   // Hit-test before rejecting off-image clicks: edge handles extend into the
   // margin and must remain draggable in both drawing and selection modes.
   const inside=this.onImage(p);
   let grabbed=!this.pending.length&&this.project.task!=='classify'?this.grabHandle(p):null;
   if(this.pose&&grabbed&&this.data.shapes[grabbed.index].shape_type!=='point')grabbed=null;
   const index=this.mode==='select'?this.hitShape(p):-1;
   if(!inside&&!grabbed&&index<0)return;
   if(e.button===1||e.button===0&&this.space){this.drag={kind:'pan',screen:[e.clientX,e.clientY],offset:[...this.offset]};this.canvas.setPointerCapture(e.pointerId);e.preventDefault();return;}
   if(e.button!==0)return;
   if(this.pose&&!grabbed){this.posePointPlaced=true;this.placePoint(p);return;}
   if(this.project.task==='classify'){this.classify();return;}
   // Shift + drag (in either mode) does the same thing as the right button, for
   // people who prefer the left hand.
   if(e.shiftKey){
    this.marquee={start:p,end:p};this.selectMany([]);
    this.canvas.setPointerCapture(e.pointerId);this.canvas.style.cursor='crosshair';
    this.hint();this.render();return;
   }
   // Existing handles are editable in either mode; unfinished contours keep
   // ownership of their clicks because grabbed is null while pending is nonempty.
   if(grabbed){
    this.selected=grabbed.index;this.selectedMany=[];this.list();
    const shape=this.data.shapes[grabbed.index],previousFuture=this.future.slice();
    this.checkpoint();
    this.drag={kind:grabbed.kind,start:p,original:clone(shape.points),vertex:grabbed.vertex,previousFuture,group:this.poseGroup(shape)};
    this.canvas.setPointerCapture(e.pointerId);
    this.hint();this.status();this.render();return;
   }
   if(this.mode==='draw'){
    const kind=this.defaultShape();
    // Polygon and brush collect points until the shape is finished; rectangle and
    // rotation are single drags; the round mark is placed in two steps.
    if(kind==='polygon'){
     if(this.pending.length>2&&Math.hypot(p[0]-this.pending[0][0],p[1]-this.pending[0][1])*this.zoom<9){this.finishPolygon();return;}
     if(!this.pending.length||Math.hypot(p[0]-this.pending.at(-1)[0],p[1]-this.pending.at(-1)[1])*this.zoom>2)this.pending.push(p);
     // The outline stays open until the user closes it (click the first point,
     // double-click, Enter or 完成轮廓). It is deliberately NOT committed at three
     // points: a three-point outline is usually just the beginning of a real one,
     // and auto-closing forced a restart on every polygon with more corners.
     this.hint();this.render();return;
    }
    if(kind==='circle'){
     // Step 1: click to set the centre. The mark starts at a small default size so
     // the arrow keys work straight away, without any dragging. Step 2: move the
     // pointer (or the arrows) to set width and height, then click to confirm.
     if(this.pending.length<2){
      const centre=this.pending[0]||p;
      const base=Math.max(4,this.circleBase||8);
      this.pending=[centre,[base,base]];this.circleArming=false;
      this.drag={kind:'circle'};this.canvas.setPointerCapture(e.pointerId);
      this.hint();this.render();return;
     }
     if(this.pending.length>=2){
      const center=this.pending[0],radii=this.pending[1];
      if(radii[0]<1.5||radii[1]<1.5){this.callbacks.toast('圆形太小了，把鼠标拖远一点再确定。');return;}
      this.checkpoint();
      this.data.shapes.push(this.makeShape(this.activeClass,'circle',[center,[radii[0],radii[1]],[center[0],center[1]+radii[1]]]));
      this.selected=this.data.shapes.length-1;this.pending=[];this.circleArming=false;this.canvas.style.cursor='crosshair';this.changed();return;
     }
     this.pending=[p];this.circleBase=8;this.hint();this.render();return;
    }
    if(kind==='brush'){
     this.checkpoint();this.brush=[p];this.drag={kind:'brush'};this.canvas.setPointerCapture(e.pointerId);this.render();return;
    }
    this.drag={kind:'new',start:p,end:p,shape:kind};this.canvas.setPointerCapture(e.pointerId);return;
   }
   const previousFuture=this.future.slice();
   this.selected=index;this.selectedMany=[];this.list();this.render();
   if(index>=0){this.checkpoint();this.drag={kind:'move',start:p,original:clone(this.data.shapes[index].points),previousFuture,group:this.poseGroup(this.data.shapes[index])};this.canvas.setPointerCapture(e.pointerId);}
  }
  move(e){
   if(!this.image)return;
   // While rotating, the pointer must be allowed outside the picture: the handle
   // of an edge-hugging box lives there, and clamping it would stall the turn.
   const rotating=this.drag?.kind==='rotate';
   const p=rotating?this.toImage(e):this.clamp(this.toImage(e));
   this.hover=p;
   if(this.marquee){this.marquee.end=p;this.render();return;}
   // Remember which vertex the pointer is over so Delete can remove just it.
   this.lastVertex=null;
   const current=this.data?.shapes[this.selected];
   if(current&&!this.drag){
    const radius=10/this.zoom;
    for(let v=0;v<current.points.length;v++){
     if(Math.hypot(p[0]-current.points[v][0],p[1]-current.points[v][1])<radius){this.lastVertex=v;break;}
    }
   }
   if(!this.drag&&!(this.circleArming&&this.pending.length>=2)){
    const handle=!this.pending.length&&this.data?this.grabHandle(p):null;
    this.canvas.style.cursor=handle&&(!this.pose||this.data.shapes[handle.index].shape_type==='point')?'grab':this.mode==='select'?'default':'crosshair';
    const hovered=handle?this.data.shapes[handle.index]:null;this.canvas.title=hovered?this.displayLabel(hovered)+(hovered.shape_type==='point'?(hovered.difficult?' · 遮挡':' · 可见'):'')+' · 拖动微调':'';
    this.syncPosePointer(this.onImage(this.toImage(e))?handle?.index:-1);
    if(this.pending.length||this.lastVertex!=null)this.render();return;
   }
   // Placing a round mark: the pointer sets both radii. This stays live after the
   // first drag is released (circleArming) so the user can move up/down for the
   // height and left/right for the width before clicking to confirm.
   if(this.pending.length&&(this.drag?.kind==='circle'||this.drag?.kind==='new'&&this.drag.shape==='circle'||this.circleArming)){
    const center=this.pending[0];
    const base=Math.max(4,this.circleBase||8);
    const rx=Math.abs(p[0]-center[0]),ry=Math.abs(p[1]-center[1]);
    // Only a pointer that actually moved away from the centre resizes the mark.
    // A pointer resting on the centre (the confirming click) leaves whatever the
    // arrow keys set, instead of overwriting it with the default size.
    if(Math.hypot(rx,ry)*this.zoom>2){
     const next=[Math.max(base,rx),Math.max(base,ry)];
     this.pending=[center,next];
     const average=(next[0]+next[1])/2;
     if(average>=4)this.circleBase=average;
    }
    this.hint();this.render();return;
   }
   const d=this.drag,s=this.data.shapes[this.selected];
   if(d.kind==='pan'){this.offset=[d.offset[0]+e.clientX-d.screen[0],d.offset[1]+e.clientY-d.screen[1]];this.render();return;}
   if(d.kind==='new'){d.end=p;this.render();return;}
   if(d.kind==='brush'){
    const last=this.brush.at(-1);
    if(!last||Math.hypot(p[0]-last[0],p[1]-last[1])*this.zoom>=1.5){this.brush.push(p);this.render();}
    return;
   }
   if(!s)return;
   if(d.kind==='vertex'){
    if(s.shape_type==='rectangle')s.points=rect(d.original[(d.vertex+2)%4],p);
    else if(s.shape_type==='circle'){
     // Vertex 0 is the centre, vertex 1 the width handle, vertex 2 the height one.
     const radii=circleRadii(d.original);
     // Always rewritten in the three-point form so the two radii stay independent.
     // The height handle sits under the centre, matching what the canvas draws.
     const pack=(rx,ry)=>{const centre=[d.original[0][0],d.original[0][1]];return [centre,[rx,ry],[centre[0],centre[1]+ry]];};
     if(d.vertex===0){const centre=[p[0],p[1]];s.points=[centre,[radii[0],radii[1]],[centre[0],centre[1]+radii[1]]];}
     else if(d.vertex===1)s.points=pack(Math.abs(p[0]-d.original[0][0])||1,radii[1]);
     else s.points=pack(radii[0],Math.abs(p[1]-d.original[0][1])||1);
    }
    else if(s.shape_type==='rotation'){
     const o=d.original,anchor=o[(d.vertex+2)%4],x=[o[1][0]-o[0][0],o[1][1]-o[0][1]],len=Math.hypot(...x)||1,u=[x[0]/len,x[1]/len],v=[-u[1],u[0]],delta=[p[0]-anchor[0],p[1]-anchor[1]],a=delta[0]*u[0]+delta[1]*u[1],b=delta[0]*v[0]+delta[1]*v[1];const corner=[anchor[0]+a*u[0]+b*v[0],anchor[1]+a*u[1]+b*v[1]],pu=[anchor[0]+a*u[0],anchor[1]+a*u[1]],pv=[anchor[0]+b*v[0],anchor[1]+b*v[1]];s.points=d.vertex%2===0?[corner,pu,anchor,pv]:[pv,corner,pu,anchor];
    }else s.points[d.vertex]=p;
   }else if(d.kind==='move'){
    const xs=d.original.map(p=>p[0]),ys=d.original.map(p=>p[1]);const dx=Math.max(-Math.min(...xs),Math.min(this.image.naturalWidth-Math.max(...xs),p[0]-d.start[0])),dy=Math.max(-Math.min(...ys),Math.min(this.image.naturalHeight-Math.max(...ys),p[1]-d.start[1]));s.points=d.original.map(v=>[v[0]+dx,v[1]+dy]);
   }else if(d.kind==='rotate'){
    // A rotating box sweeps a wider area than its upright self, so it can reach
    // past the image edge mid-turn. Refusing that (the old behaviour) meant the
    // rotation stopped part-way through and the box could not be turned 360°.
    // Instead the angle is always applied and the box is nudged back inside.
    const c=d.original.reduce((a,v)=>[a[0]+v[0]/4,a[1]+v[1]/4],[0,0]);
    const angle=Math.atan2(p[1]-c[1],p[0]-c[0])-Math.atan2(d.start[1]-c[1],d.start[0]-c[0]);
    const cos=Math.cos(angle),sin=Math.sin(angle);
    const points=d.original.map(v=>[c[0]+(v[0]-c[0])*cos-(v[1]-c[1])*sin,c[1]+(v[0]-c[0])*sin+(v[1]-c[1])*cos]);
    const xs=points.map(v=>v[0]),ys=points.map(v=>v[1]);
    let dx=0,dy=0;
    const width=this.image.naturalWidth,height=this.image.naturalHeight;
    if(Math.min(...xs)<0)dx=-Math.min(...xs);else if(Math.max(...xs)>width)dx=width-Math.max(...xs);
    if(Math.min(...ys)<0)dy=-Math.min(...ys);else if(Math.max(...ys)>height)dy=height-Math.max(...ys);
    s.points=points.map(v=>[v[0]+dx,v[1]+dy]);
    s.direction=(Math.atan2(s.points[1][1]-s.points[0][1],s.points[1][0]-s.points[0][0])+Math.PI*2)%(Math.PI*2);
   }
   if(d.group?.length){const old=d.original,n=s.points,ox=Math.min(...old.map(p=>p[0])),oy=Math.min(...old.map(p=>p[1])),ow=Math.max(...old.map(p=>p[0]))-ox,oh=Math.max(...old.map(p=>p[1]))-oy,nx=Math.min(...n.map(p=>p[0])),ny=Math.min(...n.map(p=>p[1])),nw=Math.max(...n.map(p=>p[0]))-nx,nh=Math.max(...n.map(p=>p[1]))-ny;for(const member of d.group)this.data.shapes[member.index].points=member.points.map(p=>[nx+(p[0]-ox)*nw/(ow||1),ny+(p[1]-oy)*nh/(oh||1)]);}
   this.render();this.status();
  }
  up(e){
   if(this.posePointPlaced){this.posePointPlaced=false;this.syncPosePointer();return;}
   if(this.marquee){
    // Everything the marquee touches gets selected; a plain click (tiny box)
    // clears the selection instead of selecting nothing visible.
    const box=this.marquee.start&&this.marquee.end?rect(this.marquee.start,this.marquee.end):null;
    this.marquee=null;this.canvas.style.cursor=this.mode==='select'?'default':'crosshair';
    if(this.canvas.hasPointerCapture(e.pointerId))this.canvas.releasePointerCapture(e.pointerId);
    if(box){
     const [a,b]=[box[0],box[2]];
     const big=Math.abs(b[0]-a[0])*this.zoom>3||Math.abs(b[1]-a[1])*this.zoom>3;
     // The contextmenu event follows this one; a real drag must not also close an
     // open contour.
     if(big)this.suppressContextMenu=true;
     if(big){
      const hits=this.shapesInBox(a,b);
      this.selectMany(hits);
      this.selectFromMarquee=hits;
      this.callbacks.toast(hits.length?('已框选 '+hits.length+' 个对象：按 Delete，或点右侧“框选删除”批量移除。'):'框选范围内没有对象。');
     }else this.selectMany([]);
    }
    this.list();this.hint();this.render();this.status();
    return;
   }
   if(!this.drag)return;this.move(e);const d=this.drag;this.drag=null;if(this.canvas.hasPointerCapture(e.pointerId))this.canvas.releasePointerCapture(e.pointerId);
   // Releasing the button while placing a round mark leaves it in the pending list
   // so the pointer can still be nudged; the next click commits it.
   if(d.kind==='circle'||(d.kind==='new'&&d.shape==='circle'&&this.pending.length)){
    if(this.pending.length>=2){this.circleArming=true;this.canvas.style.cursor='crosshair';this.callbacks.toast('松开也没关系：上下移动鼠标调高矮、左右移动调胖瘦，再点一下确定。');}
    this.hint();this.render();this.status();return;
   }
   if(d.kind==='brush'){
    // A brush stroke becomes a closed polygon of the sampled points.
    if(this.brush.length>=4){this.data.shapes.push(this.makeShape(this.activeClass,'polygon',clone(this.brush)));this.selected=this.data.shapes.length-1;this.brush=[];this.changed();}
    else{this.brush=[];this.history.pop();this.render();this.callbacks.toast('画笔至少要拖动出一小段距离。');this.status();}
    return;
   }
   if(d.kind==='new'&&Math.abs(d.start[0]-d.end[0])*this.zoom>4&&Math.abs(d.start[1]-d.end[1])*this.zoom>4){
    this.checkpoint();let gid=null;if(this.project.task==='pose')gid=1+Math.max(0,...this.data.shapes.map(s=>Number(s.group_id)||0));
    const kind=d.shape||this.defaultShape();
    // A circle keeps just centre + edge so its vertices can be dragged; the
    // polygon approximation is only produced when the dataset is built.
    const points=kind==='circle'?[[d.start[0],d.start[1]],[d.end[0],d.end[1]]]:rect(d.start,d.end);
    const shape=this.makeShape(this.activeClass,kind,points,gid);if(shape.shape_type==='rotation')shape.direction=0;
    this.data.shapes.push(shape);this.selected=this.data.shapes.length-1;
    if(this.project.task==='pose'){if($('#pose-placement').value==='template'){const t=this.project.template,box=rect(d.start,d.end),a=box[0],b=box[2];t.points.forEach((name,i)=>{const pos=t.positions?.[i]||[.25+(i%3)*.25,.15+Math.floor(i/3)*(.7/Math.max(1,Math.ceil(t.points.length/3)))];this.data.shapes.push(this.makeShape(name,'point',[[a[0]+(this.mirrorX?1-pos[0]:pos[0])*(b[0]-a[0]),a[1]+(this.mirrorY?1-pos[1]:pos[1])*(b[1]-a[1])]],gid));});this.setMode('select',false);this.callbacks.toast('模板已放置，请逐点拖动校准，再审核。');}else {this.pose={group:gid,index:0};this.selected=-1;this.nextOccluded=false;}}
    this.changed();
   }else if(['move','vertex','rotate'].includes(d.kind)){
    const s=this.data.shapes[this.selected];if(JSON.stringify(s.points)===JSON.stringify(d.original)){this.history.pop();this.future=d.previousFuture||[];this.status();if(!this.onImage(this.toImage(e)))this.syncPosePointer();return;}if(s?.shape_type==='rotation')s.direction=(Math.atan2(s.points[1][1]-s.points[0][1],s.points[1][0]-s.points[0][0])+Math.PI*2)%(Math.PI*2);this.changed();
   }
   if(!this.onImage(this.toImage(e)))this.syncPosePointer();
   this.render();
  }
  cancelDrag(){if(this.drag?.original&&this.selected>=0){this.data.shapes[this.selected].points=this.drag.original;for(const member of this.drag.group||[])this.data.shapes[member.index].points=member.points;this.history.pop();this.future=this.drag.previousFuture||[];}this.drag=null;this.posePointPlaced=false;this.leavePosePoint();this.render();this.status();}
  poseGroup(shape){return this.project.task==='pose'&&shape.shape_type==='rectangle'?this.data.shapes.map((s,index)=>({s,index})).filter(({s})=>s.shape_type==='point'&&s.group_id===shape.group_id).map(({s,index})=>({index,points:clone(s.points)})):[];}
  makeShape(label,type,points,group=null){return {label,shape_type:type,points,group_id:group,flags:{},difficult:false,description:'',attributes:{},kie_linking:[]};}
  // Closing the contour must never fail silently: a 2-point "polygon" is a line,
  // so it is promoted to a box instead of being dropped. Users who drew points
  // and then pressed 保存/确认 used to get "图片没有目标" with the outline still
  // visible on the canvas.
  finishPolygon(){
   const points=this.pending;
   if(!points.length)return false;
   if(this.project?.task==='classify'){this.pending=[];return false;}
   // A round mark in progress is committed as a circle/ellipse, not as a polygon.
   if(this.defaultShape()==='circle'&&points.length>=2&&Array.isArray(points[1])){
    const center=points[0],radii=points[1];
    if(radii[0]<1.5||radii[1]<1.5){this.callbacks.toast('圆形太小了，先把鼠标拖远一点。');return false;}
    this.checkpoint();
    this.data.shapes.push(this.makeShape(this.activeClass,'circle',[center,[radii[0],radii[1]],[center[0],center[1]+radii[1]]]));
    this.selected=this.data.shapes.length-1;this.pending=[];this.circleArming=false;this.changed();
    return true;
   }
   if(points.length<3){
    if(points.length===2){
     this.checkpoint();
     this.data.shapes.push(this.makeShape(this.activeClass,'rectangle',rect(points[0],points[1])));
     this.selected=this.data.shapes.length-1;this.pending=[];this.changed();
     this.callbacks.toast('只有两个点，已按矩形保存。继续画多边形请重新选“多边形”。');
     return true;
    }
    this.pending=[];this.render();this.hint();
    this.callbacks.toast('多边形至少需要 3 个点。');
    return false;
   }
   this.checkpoint();
   this.data.shapes.push(this.makeShape(this.activeClass,'polygon',clone(points)));
   this.selected=this.data.shapes.length-1;this.pending=[];this.changed();
   return true;
  }
  // Called before saving/approving: closes an in-progress contour, or reports why
  // it cannot be closed yet, so the button never acts on a shape the user cannot see.
  closePendingContour(){
   if(!this.pending.length)return true;
   // One or two points still describe an area, so they become a box rather than
   // being thrown away.
   if(this.pending.length>=2)return this.finishPolygon();
   this.callbacks.toast('轮廓至少需要 2 个点；继续点选，或按 Esc 取消。');
   return false;
  }
  setOccluded(value){
   const shape=this.data?.shapes[this.selected];
   if(shape?.shape_type==='point'){this.checkpoint();shape.difficult=!!value;this.changed();}
   else if(this.pose){this.nextOccluded=!!value;this.hint();}
   else this.callbacks.toast('请先选中一个骨点，或画框开始顺序点选。');
  }
  objectOcclusionTargets(){
   if(!this.data)return [];
   const indexes=this.selectedMany.length>1?this.selectedMany:[this.selected];
   return indexes.map(i=>this.data.shapes[i]).filter(s=>s&&s.shape_type!=='point');
  }
  syncObjectOcclusion(){
   const control=$('#object-occluded'),section=$('#object-occlusion-controls');if(!control||!section)return;
   const classify=this.project?.task==='classify',targets=this.objectOcclusionTargets();
   section.hidden=!this.project||(this.project.task==='pose'&&(!!this.pose||this.data?.shapes[this.selected]?.shape_type==='point'));
   control.disabled=!this.data||(!classify&&!targets.length);
   control.checked=classify?!!this.data?.occluded:!!targets.length&&targets.every(s=>!!s.flags?.occluded);
   control.indeterminate=!classify&&targets.some(s=>!!s.flags?.occluded)&&!control.checked;
   $('#object-occluded-label').textContent=classify?'照片中的分类主体被遮挡':targets.length>1?'选中对象被遮挡（批量）':'选中对象被遮挡';
   $('#object-occlusion-help').textContent=classify?'标记当前照片主体的遮挡情况，不作为额外分类标签。用于复核，普通 YOLO 分类训练不单独使用。':this.project?.task==='pose'?'此项标记整个目标；骨点遮挡请单独设置，不会自动改变各骨点可见性。':'先选中对象再勾选，支持框选后批量设置。此标记用于复核，普通 YOLO 训练不单独使用。';
  }
  setObjectOccluded(value){
   if(!this.data)return;
   const classify=this.project?.task==='classify',targets=this.objectOcclusionTargets();
   if(!classify&&!targets.length){this.callbacks.toast('请先选择需要标记遮挡的对象。');return;}
   this.checkpoint();
   if(classify)this.data.occluded=!!value;
   else for(const shape of targets){shape.flags??={};shape.flags.occluded=!!value;}
   this.changed();
  }
  placePoint(p){
   if(!this.pose||!this.onImage(p))return;
   this.checkpoint();const t=this.project.template;
   const shape=this.makeShape(t.points[this.pose.index],'point',[this.clamp(p)],this.pose.group);
   shape.difficult=!!this.nextOccluded;this.data.shapes.push(shape);this.selected=-1;this.nextOccluded=false;
   this.pose.index++;if(this.pose.index>=t.points.length)this.setMode('select',false);this.changed();
  }
  skipPoint(){
   const shape=this.data?.shapes[this.selected];
   if(shape?.shape_type==='point'){
    this.checkpoint();this.data.shapes.splice(this.selected,1);this.selected=-1;this.changed();
    this.callbacks.toast('该骨点已设为未知（训练可见性 0），可撤销恢复。');return;
   }
   if(!this.pose){this.callbacks.toast('请选中要设为未知的骨点，或画框开始顺序点选。');return;}
   this.checkpoint();this.pose.index++;this.nextOccluded=false;
   if(this.pose.index>=this.project.template.points.length)this.setMode('select',false);this.changed();
  }
  mirrorPose(axis){
   if(this.project?.task!=='pose'||!this.data)return;
   const selected=this.data.shapes[this.selected],group=selected?.group_id??this.pose?.group;
   const box=this.data.shapes.find(s=>s.shape_type==='rectangle'&&s.group_id===group);
   if(group==null||!box){this.callbacks.toast('请先选择要镜像的骨架或目标框。');return;}
   const points=this.data.shapes.filter(s=>s.shape_type==='point'&&s.group_id===group);
   if(!points.length)return;
   this.checkpoint();const at=axis==='y'?1:0,coords=box.points.map(p=>p[at]),sum=Math.min(...coords)+Math.max(...coords);
   for(const point of points)point.points=point.points.map(p=>{const next=p.slice();next[at]=sum-p[at];return this.clamp(next);});
   this.changed();this.callbacks.toast(axis==='y'?'当前骨架已上下反转。':'当前骨架已左右镜像，骨点名称保持对应。');
  }
  classify(){if(!this.data||!this.activeClass)return;this.checkpoint();this.data.flags=Object.fromEntries(this.project.classes.map(c=>[c,c===this.activeClass]));this.changed();}
  relabel(){if(this.project?.task==='classify'){this.classify();return;}const s=this.data?.shapes[this.selected];if(!s){this.callbacks.toast('先选择一个标注对象。');return;}if(s.shape_type==='point'){this.callbacks.toast('关键点名称由姿态模板定义，不能改成对象类别。');return;}this.checkpoint();s.label=this.activeClass;this.changed();}
  remove(){if(this.selectedMany.length)return this.removeSelectedMany();const s=this.data?.shapes[this.selected];if(!s)return;this.checkpoint();if(this.project.task==='pose'&&s.shape_type==='rectangle')this.data.shapes=this.data.shapes.filter(x=>x.group_id!==s.group_id);else this.data.shapes.splice(this.selected,1);this.selected=-1;this.pose=null;this.changed();}
  // Deletes a single vertex of the selected polygon (>=3 points must remain).
  removeVertex(){
   const s=this.data?.shapes[this.selected];
   if(!s||s.shape_type!=='polygon'){if(s)this.callbacks.toast('只有多边形可以单独删除顶点。');return false;}
   const at=this.lastVertex;
   if(at==null){this.callbacks.toast('把鼠标移到要删除的顶点上，再按 Delete。');return false;}
   if(s.points.length<=3){this.callbacks.toast('多边形至少保留 3 个顶点。');return false;}
   this.checkpoint();s.points.splice(at,1);this.lastVertex=null;this.changed();this.callbacks.toast('已删除 1 个顶点，剩余 '+s.points.length+' 个。');return true;
  }
  setClass(name,silent){
   if(!name||!this.project?.classes.includes(name))return;
   this.activeClass=name;$('#active-class').value=name;this.classButtons();
   if(this.selected>=0){const s=this.data?.shapes[this.selected];if(s&&s.shape_type!=='point'){s.label=name;this.changed();}}
   if(this.project.task==='classify')this.classify();
   else if(!silent)this.callbacks.toast('当前类别：'+name);
  }
  cycleClass(step){
   const classes=this.project?.classes||[];
   if(classes.length<2)return;
   const at=Math.max(0,classes.indexOf(this.activeClass));
   this.chooseClass(classes[(at+step+classes.length)%classes.length]);
  }
  list(){
   const list=$('#shape-list');list.replaceChildren();this.syncObjectOcclusion();$('#shape-count').textContent=this.data?.shapes.length||0;
   $('#relabel-selected').disabled=!this.data||(this.project?.task!=='classify'&&(!this.data.shapes[this.selected]||this.data.shapes[this.selected].shape_type==='point'));if(!this.data)return;
   this.data.shapes.forEach((s,i)=>{const b=document.createElement('button');b.className='shape-row'+(i===this.selected?' selected':'')+(this.isMultiSelected(i)?' multi':'');const dot=document.createElement('i');dot.style.background=this.color(s);const label=document.createElement('span');label.textContent=this.displayLabel(s);const info=document.createElement('small');info.textContent=s.shape_type==='point'?(s.difficult?'遮挡骨点':'可见骨点'):s.flags?.occluded?'遮挡对象':({rectangle:'目标框',polygon:'分割轮廓',rotation:'旋转框'}[s.shape_type]||'标注');b.title=this.displayLabel(s)+this.suffix(s)+' · 单击选中，可拖动微调或删除';b.append(dot,label,info);b.onclick=()=>{this.selected=i;this.selectedMany=[];if(!this.pose)this.setMode('select',false);this.hint();$('#occluded').checked=!!s.difficult;this.list();this.render();};list.append(b);});
   if(this.selectedMany.length>1){const note=document.createElement('p');note.className='muted multi-note';note.textContent='已框选 '+this.selectedMany.length+' 个对象：按 Delete、点“删除”或点“框选删除”批量移除。';list.prepend(note);}
  }
  wheel(e){if(!this.image)return;e.preventDefault();const p=this.toImage(e),r=this.canvas.getBoundingClientRect();const next=Math.max(.02,Math.min(30,this.zoom*(e.deltaY<0?1.15:1/1.15)));this.zoom=next;this.offset=[e.clientX-r.left-p[0]*next,e.clientY-r.top-p[1]*next];this.render();}
  key(e){
   const typing=e.target.isContentEditable||e.target.tagName==='TEXTAREA'||e.target.tagName==='INPUT'&&!['checkbox','radio','button'].includes(e.target.type);
   const modal=!!document.querySelector('dialog[open]');
   if(!e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.isComposing&&e.key.toLowerCase()==='e'){
    if(this.callbacks.isEditor()&&!modal&&!typing){
     e.preventDefault();window.getSelection?.()?.removeAllRanges();if(!e.repeat&&this.proposal&&!this.accepting)this.accept();
    }
    return;
   }
   if(this.callbacks.isEditor()&&!modal&&!typing&&(this.project?.classes.length||0)>1&&e.key.toLowerCase()==='q'&&!e.isComposing&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();if(!e.repeat)this.cycleClass(e.shiftKey?-1:1);return;}
   if(e.code==='Space'&&!/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)&&this.callbacks.isEditor()){this.space=e.type==='keydown';e.preventDefault();}
   if(!this.callbacks.isEditor()||e.target.isContentEditable||(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)&&!((e.target.id==='occluded'&&/^[ko]$/i.test(e.key))||(e.target.id==='object-occluded'&&/^o$/i.test(e.key))))||document.querySelector('dialog[open]'))return;
   if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(!e.repeat)this.approve();return;}
   if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.key.toLowerCase()==='o'&&!this.pose&&this.data?.shapes[this.selected]?.shape_type!=='point'){
    e.preventDefault();if(!e.repeat)this.setObjectOccluded(!$('#object-occluded').checked);return;
   }
   if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&this.project?.task==='pose'){
    if(['k','o','h'].includes(e.key.toLowerCase())){
     e.preventDefault();if(e.repeat)return;
     if(e.key.toLowerCase()==='k')this.skipPoint();
     else if(e.key.toLowerCase()==='o')this.setOccluded(!$('#occluded').checked);
     else this.mirrorPose(e.shiftKey?'y':'x');return;
    }
   }
   // Bare "S" saves too: annotators asked for one-key saving between shapes.
   if(e.key.toLowerCase()==='s'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();if(!e.repeat)this.approve();return;}
   if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?this.redo():this.undo();return;}
   // Arrow keys size a round mark being placed: Up/Down is height, Left/Right is
   // width. A round mark can be made without dragging at all.
   if(this.pending.length>=2&&this.defaultShape()==='circle'&&/^Arrow(Up|Down|Left|Right)$/.test(e.key)){
    e.preventDefault();
    const step=e.shiftKey?10:2,center=this.pending[0],radii=this.pending[1].slice();
    if(e.key==='ArrowUp')radii[1]=Math.max(1,radii[1]+step);
    if(e.key==='ArrowDown')radii[1]=Math.max(1,radii[1]-step);
    if(e.key==='ArrowRight')radii[0]=Math.max(1,radii[0]+step);
    if(e.key==='ArrowLeft')radii[0]=Math.max(1,radii[0]-step);
    this.pending=[center,radii];this.circleArming=true;
    this.callbacks.toast('宽 '+Math.round(radii[0]*2)+' × 高 '+Math.round(radii[1]*2)+' 像素（Shift 加大步长）· 点一下确定');
    this.hint();this.render();return;
   }
   if(e.key==='Escape'){this.pending=[];this.brush=[];this.pose=null;this.marquee=null;this.selectedMany=[];this.circleArming=false;this.canvas.style.cursor='crosshair';this.cancelDrag();this.list();this.hint();this.render();}
   if(e.key==='Enter')this.finishPolygon();
   if(e.key==='Delete'||e.key==='Backspace'){
    e.preventDefault();
    if(this.selectedMany.length){this.removeSelectedMany();return;}
    if(this.pending.length){this.pending.pop();this.hint();this.render();return;}
    if(this.removeVertex())return;
    this.remove();
    return;
   }
   // Cycling classes with [ and ] avoids reaching for the number row.
   if(e.key==='['||e.key===']'){e.preventDefault();this.cycleClass(e.key===']'?1:-1);return;}
   if(e.ctrlKey||e.metaKey||e.altKey)return;
   if(e.key.toLowerCase()==='v')this.setMode('select');
   if(e.key.toLowerCase()==='r'&&this.project?.task!=='classify')this.setMode('draw');
   if(e.key.toLowerCase()==='a')this.callbacks.navigate(-1);
   if(e.key.toLowerCase()==='d')this.callbacks.navigate(1);
   if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&/^[1-9]$/.test(e.key)&&this.project?.classes[Number(e.key)-1])this.chooseClass(this.project.classes[Number(e.key)-1]);
  }
  async save(checked=false){
   const requestedName=this.name,requestedRoot=this.project?.root;
   while(this.saving){await this.saving;if(this.name!==requestedName||this.project?.root!==requestedRoot)return false;}
   if(!this.data||!this.name)return false;
   this.finalizing=true;
   try{if(this.pending.length&&!this.closePendingContour())return false;}finally{this.finalizing=false;}
   if(!this.dirty&&(!checked||this.data.checked))return true;
   const source=this.data,name=this.name,root=this.project?.root,annotation=clone(source),fingerprint=JSON.stringify(source),baseHash=this.baseHash;
   let operation;
   operation=Promise.resolve().then(async()=>{
    const result=await this.callbacks.rpc('save_annotation',{name,annotation,base_hash:baseHash,checked});
    if(this.name===name&&this.project?.root===root&&this.data===source){
     this.baseHash=result.base_hash;
     if(JSON.stringify(this.data)===fingerprint){this.dirty=false;this.data.checked=result.checked;}
    }
    this.callbacks.onSave?.();return true;
   }).finally(()=>{if(this.saving===operation)this.saving=null;this.status();});
   this.saving=operation;this.status();return operation;
  }
  async settleEdits(){
   if(this.accepting)await this.accepting;
   do{
    if(this.confirming)await this.confirming;
    const saved=await this.save();
    if(!saved&&(this.dirty||this.pending.length))throw new Error('请先完成当前轮廓再切换图片，当前画面和标注已保留。');
   }while(this.dirty);
  }
  runConfirmation(action){
   if(this.confirming)return this.confirming;
   let operation;
   operation=Promise.resolve().then(action).finally(()=>{if(this.confirming===operation)this.confirming=null;this.status();});
   this.confirming=operation;this.status();return operation;
  }
  confirmSave(){
   return this.runConfirmation(async()=>{
    try{
     if(!this.data)return false;
     const name=this.name,source=this.data;
     if(this.pose){this.callbacks.toast('请先完成骨点，或按 K 跳过未知点，再保存审核。');return false;}
     if(this.pending.length&&!this.closePendingContour())return false;
     if(this.proposal&&!this.data.shapes.length&&!Object.values(this.data.flags||{}).some(v=>v===true)){this.callbacks.toast('AI 建议尚未接纳，请先点击“接纳候选并微调”，检查后再保存审核。');return false;}
     await this.save(true);
     const confirmed=this.name===name&&this.data===source&&!this.dirty&&this.data.checked;
     if(confirmed)this.callbacks.toast('已保存并审核，可用于训练。');return confirmed;
    }catch(e){this.callbacks.toast(e.message);return false;}
   });
  }
  approve(){
   if(this.approving)return this.approving;
   const name=this.name,root=this.project?.root,advance=this.callbacks.prepareNext?.();
   let operation;
   operation=Promise.resolve().then(async()=>{
    if(await this.confirmSave()&&this.name===name&&this.project?.root===root){
     if(advance)await advance();else await this.callbacks.navigate(1);
    }
   }).catch(e=>this.callbacks.toast(e.message)).finally(()=>{if(this.approving===operation)this.approving=null;this.status();});
   this.approving=operation;this.status();return operation;
  }
  candidate(){
   const count=this.proposal?.annotation?.shapes?.length||0,flags=Object.entries(this.proposal?.annotation?.flags||{}).filter(([,v])=>v===true).map(([k])=>k);
   $('#candidate-count').textContent=this.proposal?String(count||flags.length):'0';
   $('#candidate-info').textContent=this.proposal?(flags.length?'AI 建议类别：'+flags.join('、')+'。接纳后可修改。':count+' 个候选图形，以橙色虚线显示。先接纳，再拖动微调并保存审核。'):'当前图片尚无待接纳候选';
   $('#accept-candidate').disabled=!this.proposal||!!this.accepting;
   if(this.proposal){const section=document.querySelector('.candidate-section');if(section)section.open=true;}
  }
  accept(){
   if(this.accepting)return this.accepting;
   if(!this.proposal)return Promise.resolve(false);
   const name=this.name,root=this.project?.root;
   let operation;
   operation=Promise.resolve().then(async()=>{
    try{
     if(this.pose||this.pending.length){this.callbacks.toast('请先完成当前标注，再接纳 AI 候选。');return false;}
     await this.save();
     if(this.name!==name||this.project?.root!==root)return false;
     const label=await this.callbacks.rpc('accept',{name});
     if(this.name!==name||this.project?.root!==root)return false;
     // open(name) intentionally reuses the currently displayed image; apply the
     // authoritative RPC response here instead of relying on that short circuit.
     if(!label?.annotation)throw new Error('接纳结果读取失败，请重新打开图片。');
     this.data=clone(label.annotation);this.data.shapes??=[];this.data.flags??={};
     this.baseHash=label.base_hash;this.proposal=label.proposal;this.dirty=false;this.selected=-1;this.selectedMany=[];this.history=[];this.future=[];
     this.setMode('select',false);this.list();this.render();this.status();this.hint();this.candidate();this.callbacks.onSave?.();
     this.callbacks.toast('AI 候选已接纳，可以拖动微调，检查后保存审核。');return true;
    }catch(e){this.callbacks.toast(e.message);return false;}
   }).finally(()=>{if(this.accepting===operation)this.accepting=null;this.candidate();});
   this.accepting=operation;this.candidate();return operation;
  }

 }
 document.addEventListener('keyup',e=>{if(e.code==='Space'&&window.editor)window.editor.space=false;});
 window.AnnotationEditor=AnnotationEditor;
})();
