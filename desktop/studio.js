const api=window.workbench,$=s=>document.querySelector(s);
// One consistent 24px grid, 1.7 stroke, round joins: simple silhouettes read far
// better at 18px than the previous mixed-weight drawings.
const iconPaths={
 data:'<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 3.5v17M14.5 3.5v17"/>',
 editor:'<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.5"/><path d="M3.5 7V5.5A2 2 0 0 1 5.5 3.5H7M17 3.5h1.5a2 2 0 0 1 2 2V7M20.5 17v1.5a2 2 0 0 1-2 2H17M7 20.5H5.5a2 2 0 0 1-2-2V17"/>',
 models:'<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m12 8.2 1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/>',
 review:'<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m7 12.4 3.4 3.4L17 8.6"/>',
 train:'<path d="M3.5 19.5h17"/><path d="M6.5 16.5v-4M11 16.5v-8M15.5 16.5v-5.5M20 16.5V6"/>',
 validate:'<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M7.5 14.5l3-3.5 2.5 2.5 3.5-4.5"/>',
 advanced:'<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M9.5 3.5v17M9.5 10h11M9.5 15h11"/>',
 plus:'<path d="M12 4.5v15M4.5 12h15"/>',
 select:'<path d="M5 3.5 6.6 12l2-2.6 3.4.9z"/><path d="m11.5 12 6.5 6.5"/>',
 detect:'<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><rect x="7.5" y="9" width="9" height="6" rx="1"/>',
 segment:'<path d="M8.4 3.4 20.6 6.2 17.6 19.4 5.4 16.6z"/><circle cx="8.4" cy="3.4" r="1.7"/><circle cx="20.6" cy="6.2" r="1.7"/><circle cx="5.4" cy="16.6" r="1.7"/><circle cx="17.6" cy="19.4" r="1.7"/>',
 pose:'<circle cx="12" cy="4.4" r="2.4"/><path d="M12 6.9v5.4M6.4 9.4 12 11.4l5.6-2M12 12.3 7.3 19.6M12 12.3l4.7 7.3"/>',
 obb:'<path d="m8.2 5.6 12.2 3.2-3 11.6L5.2 17.2z"/><path d="M15.6 2.6h5.8v5.8"/>',
 classify:'<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M7.5 9h9M7.5 12.6h9M7.5 16.2h5.5"/>'
};
window.workflowIcon=name=>'<svg class="workflow-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+(iconPaths[name]||iconPaths.detect)+'</svg>';
for(const button of document.querySelectorAll('.nav-item[data-page]'))button.querySelector('span').innerHTML=workflowIcon(button.dataset.page);
$('#new-project>span').innerHTML=workflowIcon('plus');
for(const button of document.querySelectorAll('[data-task]')){button.firstChild.textContent='';button.insertAdjacentHTML('afterbegin',workflowIcon(button.dataset.task));}
$('#tool-select').innerHTML=workflowIcon('select')+'选择';
const taskNames={detect:'目标检测',segment:'实例分割',pose:'姿态检测',obb:'旋转框检测',classify:'图片分类'};
const taskHints={detect:'拖动画矩形框，标出每个目标的位置。',segment:'逐点勾画实例轮廓，双击或 Enter 完成多边形。',pose:'先框对象，再放置或顺序点选关键点；支持人、狗与自定义模板。',obb:'先画框，再通过旋转手柄调整方向。',classify:'为整张图片选择一个类别，不需要画框。'};
// Which shapes each task can actually train on. The picker only offers these,
// so a project can never hold a shape its task cannot learn.
const taskShapes={
 detect:[{id:'rectangle',icon:'detect',name:'矩形框',hint:'最常用的目标定位方式，适合人、车、动物等。'},
         {id:'polygon',icon:'segment',name:'多边形',hint:'沿物体边缘逐点勾画；训练时按外接矩形使用，原始轮廓会保留。'},
         {id:'rotation',icon:'obb',name:'旋转矩形框',hint:'带方向的框，适合斜放物体或航拍；选择后项目会按旋转框任务训练。'},
         {id:'circle',icon:'detect',name:'圆形',hint:'拖动画圆，适合圆形目标；训练时按外接矩形使用，原始圆形会保留。'}],
 segment:[{id:'polygon',icon:'segment',name:'多边形',hint:'沿物体边缘逐点勾画，适合不规则轮廓。'},
          {id:'brush',icon:'segment',name:'画笔',hint:'按住鼠标左键涂画轮廓，适合快速圈出不规则目标。'},
          {id:'circle',icon:'detect',name:'圆形',hint:'拖动画圆；训练时按外接矩形使用，原始圆形会保留。'}],
 pose:[{id:'rectangle',icon:'pose',name:'矩形框 + 关键点',hint:'先框出对象，再放置或点选骨点。'}],
 obb:[{id:'rotation',icon:'obb',name:'旋转矩形框',hint:'带方向的框，适合航拍、文字、斜放物体。'}],
 classify:[{id:'image',icon:'classify',name:'整图类别',hint:'每张图片只选一个类别，不需要画框。'}]
};
let newShape='rectangle';
let state={ready:false,project:null},page='data',items=[],paging={page:0,pages:1},galleryKey='',projectKey='',modelKey='',modelsContext='',modelGeneration=0,newTask='detect',projectsHome='',newRootEdited=false,toastTimer,searchTimer,loadSequence=0,refreshPending=null,trainingPending=false;
// "保存草稿" approves by default because most users mark their own data; the
// switch in the editor toolbar turns that off for outside annotators.
const AUTO_APPROVE_KEY='annotation-workbench:auto-approve';
const autoApprove=()=>{try{return localStorage.getItem(AUTO_APPROVE_KEY)!=='0';}catch{return true;}};
const setAutoApprove=value=>{try{localStorage.setItem(AUTO_APPROVE_KEY,value?'1':'0');}catch{}};
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6000);}
async function rpc(method,args={}){const result=await api.rpc(method,args);if(!result.ok)throw new Error(result.error);return result.result;}
window.editor=new AnnotationEditor({rpc,toast,isEditor:()=>page==='editor',navigate:step=>navigate(step),autoApprove:()=>autoApprove(),onSave:()=>{galleryKey='';loadImages();}});
const editor=window.editor;

async function go(next){
 const review=next==='review';
 try{
  if(next!==page)await editor.save();
  if(next==='review'){$('#image-filter').value='pending';paging.page=0;next='data';await loadImages();}
  if(next==='editor'&&!state.project){showNew();return;}
  page=next;
  document.querySelectorAll('main>section').forEach(section=>section.hidden=section.id!=='page-'+page);
  document.querySelectorAll('.nav-item[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===(review?'review':page)));
  $('#crumb-page').textContent=review?'人工审查 · 待确认图片':{data:'数据与标注',editor:'标注画布',models:'模型预标注',train:'模型训练',validate:'模型验证'}[page];
  // The image list drives the canvas. On a fresh start it is still empty, so an
  // entry into the canvas used to leave a blank picture with an empty label list.
  if(page==='editor'&&!items.length&&state.project)await loadImages();
  if(page==='editor'){editor.fit();if(!editor.name&&items[0]){await editor.open(items[0].name);renderFilmstrip();}}
  if(page==='train'||page==='models')await refreshModels();
  if(page==='train')refreshTrainingResults();
  if(page==='data'||page==='train')refreshSplitPreview();
  if(page==='validate'){await refreshModels();await refreshValidationPlots();}
 }catch(e){toast(e.message);}
}
// A photo that should not be in the dataset (blurred, duplicated, wrong class)
// leaves the project here instead of sitting in the queue forever. Unsaved edits
// are written first so they move to removed/ together with the picture, and the
// next picture opens automatically so reviewing can continue.
async function removeImage(name,quiet=false){
 const target=name||editor.name;
 if(!target)return;
 if(!quiet&&!confirm(`把「${target}」移出这个数据集？\n\n图片、标注和该图的训练/验证划分会一起移入项目的 removed 文件夹，可以再取回；不会直接删除。`))return;
 const index=items.findIndex(item=>item.name===target);
 try{
  // Write pending edits first so they travel into removed/ with the picture.
  if(editor.name===target)await editor.save().catch(()=>{});
  const result=await rpc('remove_image',{name:target,purge:false});
  // Let go of the picture before refreshing, otherwise the filmstrip or the
  // canvas asks for a thumbnail of a file that is already gone.
  if(editor.name===target)editor.forget();
  const refreshed=await loadImages();
  // Prefer the refreshed list; fall back to the live one if a concurrent refresh
  // won the token race and returned early.
  const list=Array.isArray(refreshed)?refreshed:items;
  const next=list[Math.min(index,list.length-1)]||list[0];
  if(next)await openImage(next.name);
  toast(`已移除「${target}」（含 ${result.removed.length} 个文件）${next?'，已切到下一张。':'。'}`);
 }catch(error){toast(error.message);}
}
$('#remove-image').onclick=()=>removeImage();
async function openImage(name){
 try{
  await go('editor');
  await editor.open(name);
  renderFilmstrip();
 }
 catch(e){toast(e.message);}
}
// Navigation follows the whole filtered list, not just the loaded page: stepping
// past the end pulls the next page in and opens its first image, so a long
// dataset can be worked through without going back to the grid.
async function navigate(step){
 if(!items.length)return;
 let index=items.findIndex(item=>item.name===editor.name);
 if(index<0)index=step>0?-1:items.length;
 const target=index+step;
 if(target>=0&&target<items.length){await openImage(items[target].name);return;}
 if(step>0){
  if(paging.page>=paging.pages-1){toast('已经是筛选范围里的最后一张。');return;}
  paging.page++;await loadImages();
  if(items.length)await openImage(items[0].name);
  return;
 }
 if(paging.page<=0){toast('已经是筛选范围里的第一张。');return;}
 paging.page--;await loadImages();
 if(items.length)await openImage(items[items.length-1].name);
}
async function jumpTo(edge){
 if(!items.length)return;
 if(edge==='first'){paging.page=0;await loadImages();if(items.length)await openImage(items[0].name);}
 else{paging.page=Math.max(0,paging.pages-1);await loadImages();if(items.length)await openImage(items[items.length-1].name);}
}
async function loadImages(){
 const token=++loadSequence;
 // Tracked so a refresh that loses the race can wait for the winner instead of
 // reporting names from before the change (see below).
 const run=(async()=>{
  const result=await api.images({page:paging.page,filter:$('#image-filter').value,search:$('#image-search').value.trim(),dpr:window.devicePixelRatio||1,size:Number($('#page-size').value)||24});
  if(token!==loadSequence)return null;
  items=result.items;paging=result;$('#image-total').textContent=result.total+' 张图片';$('#page-number').textContent=(result.page+1)+' / '+result.pages;$('#prev-page').disabled=!result.page;$('#next-page').disabled=result.page>=result.pages-1;
  const gallery=$('#gallery');gallery.replaceChildren();
  if(!items.length){const box=document.createElement('div');box.className='empty-gallery';const title=document.createElement('strong'),description=document.createElement('p');title.textContent=state.project?'没有符合筛选条件的图片':'还没有项目';description.textContent=state.project?'调整筛选条件或清除搜索词。':'新建项目后，图片、标注和训练结果会集中在一起。';box.append(title,description);if(!state.project){const action=document.createElement('button');action.className='primary';action.textContent='新建项目';action.onclick=()=>showNew();box.append(action);}gallery.append(box);}
  for(const item of items){const button=document.createElement('button');button.className='image-tile';button.setAttribute('aria-label','标注 '+item.name);const img=document.createElement('img');img.src=item.thumbnail;img.alt=item.name;const detail=document.createElement('div'),name=document.createElement('strong'),status=document.createElement('small');name.textContent=item.name;status.textContent={checked:'已审核',draft:'编辑中',unlabeled:'未标注'}[item.status];status.className=item.status;detail.append(name,status);
   // Removing from the grid too: an unusable photo is often spotted while
   // browsing, not only while annotating it.
   const drop=document.createElement('button');drop.className='tile-remove';drop.type='button';drop.textContent='移除';drop.title='把这张图片移出数据集';drop.onclick=event=>{event.stopPropagation();removeImage(item.name);};
   button.append(img,detail,drop);button.onclick=()=>openImage(item.name);gallery.append(button);}
  renderFilmstrip();
  return items;
 })();
 refreshPending=run;
 try{
  const list=await run;
  // A newer refresh started while this one was in flight (the periodic status
  // poll does that). Wait for it rather than handing back the list as it was
  // before the change; otherwise stepping to the successor of a removed picture
  // picked the removed picture again.
  if(list===null&&refreshPending&&refreshPending!==run)await refreshPending.catch(()=>{});
  return items;
 }finally{if(refreshPending===run)refreshPending=null;}
}
function renderFilmstrip(){const strip=$('#filmstrip');strip.replaceChildren();for(const item of items){const button=document.createElement('button');button.className='film-item'+(item.name===editor.name?' selected':'');const image=document.createElement('img');image.src=item.thumbnail;image.alt=item.name;const name=document.createElement('small');name.textContent=item.name;button.append(image,name);button.onclick=()=>openImage(item.name);strip.append(button);}}
function update(next){
 const previous=state;state=next;document.documentElement.dataset.theme=next.resolvedTheme||'dark';
 document.querySelectorAll('button[data-theme]').forEach(b=>b.classList.toggle('selected',b.dataset.theme===next.theme));
 $('#engine-state').textContent=next.ready?'本地引擎就绪':'启动本地引擎…';$('#engine-dot').classList.toggle('ready',!!next.ready);
 $('#notice').hidden=!next.error;$('#notice-text').textContent=next.error||'';
 const project=next.project,c=project?.counts||{total:0,checked:0,draft:0};
 $('#sidebar-project').textContent=project?.name||'选择或新建项目';$('#sidebar-task').textContent=taskNames[project?.task]||'支持五种视觉任务';
 $('#crumb-project').textContent=project?.name||'工作台';$('#project-title').textContent=project?.name||'从一组图片开始';$('#project-subtitle').textContent=project?'点击图片直接标注，审核后即可训练。三种方式可随时切换。':'选择任务、定义类别，然后直接在画布中标注。';
 $('#sidebar-count').textContent=c.total;$('#count-total').textContent=c.total;$('#count-checked').textContent=c.checked;$('#count-draft').textContent=c.draft;$('#count-pending').textContent=Math.max(0,c.total-c.checked-c.draft);$('#task-tag').textContent=taskNames[project?.task]||'尚未打开项目';$('#project-path').textContent=project?.root||'';
 $('#mode').value=project?.mode||'manual';document.querySelectorAll('[data-flow]').forEach(b=>b.classList.toggle('selected',b.dataset.flow===(project?.mode||'manual')));
 $('#training-ready').textContent=project?c.checked+' / '+c.total+' 张已审核': '请先建立项目并标注图片';$('#training-task').textContent=project?taskNames[project.task]+' · '+project.classes.join('、'):'';
 // The split belongs to the dataset, so it previews on the data page too.
 if(project&&(page==='train'||page==='data'))refreshSplitPreview();
 const info=next.training_info&&next.training_info.project===project?.root?next.training_info:{status:'idle',logs:[]};const running=['starting','training'].includes(info.status);
 state.validationInfo=next.validation_info;state.trainingInfo=info;
 $('#training-status').textContent=trainingPending?'准备已审核数据快照…':({idle:'尚未开始',starting:'正在准备环境',training:'训练中',completed:'训练完成',failed:'训练失败',stopped:'已停止'}[info.status]||info.status);
 $('#training-run').textContent=info.error||info.run||'';
 renderTrainingProgress(info);
 const logs=$('#training-log');const auto=$('#training-autoscroll').checked;const lines=info.logs||[];
 // Replacing the whole text on every poll would fight the user's scrolling, so
 // only touch the DOM when the log actually grew.
 if(lines.length!==Number(logs.dataset.lines||-1)){
  logs.dataset.lines=String(lines.length);
  const atEnd=logs.scrollTop+logs.clientHeight>=logs.scrollHeight-30;
  logs.textContent=lines.join('\n')||'训练开始后在这里显示真实日志。';
  if(auto||atEnd)logs.scrollTop=logs.scrollHeight;
 }
 $('#train-start').disabled=trainingPending||running||!next.ready||!project||c.checked<2;$('#train-start').title=c.checked<2?'请先标注并审核至少两张内容不同的图片。':'';$('#train-stop').disabled=!running;
 renderValidation(next.validation_info,project);
 $('#predict-start').disabled=!!next.predicting||!!next.native_training||running||!next.ready||!project;$('#predict-stop').disabled=!next.predicting;$('#predict-status').textContent=next.predicting?'正在生成全部图片候选…':({idle:'尚未生成候选',completed:'候选已生成，请进入人工审查',failed:'预标注失败，请查看日志中的原因',stopped:'已停止，已生成的候选仍保留'}[next.prediction_status]||'尚未生成候选');$('#predict-log').textContent=next.prediction_log||'';
 const pk=JSON.stringify([project?.root,project?.classes,project?.template]);if(pk!==projectKey){projectKey=pk;editor.setProject(project);modelKey='';refreshModels();}
 const key=JSON.stringify([project?.root,c.total,c.checked,c.draft,next.predicting,Math.round((window.devicePixelRatio||1)*10)]);if(key!==galleryKey){galleryKey=key;loadImages();}
 // results.csv grows every epoch, so poll it while training runs to keep the
 // meter and the loss/mAP numbers live instead of frozen until the end.
 if(running&&!trainingPoll){trainingPoll=setInterval(()=>refreshTrainingResults(),2500);}
 if(!running&&trainingPoll){clearInterval(trainingPoll);trainingPoll=null;refreshTrainingResults();}
 if(previous.predicting&&!next.predicting&&editor.name&&!editor.dirty)rpc('load_annotation',{name:editor.name}).then(label=>{editor.proposal=label.proposal;editor.candidate();editor.render();}).catch(e=>toast(e.message));
 if(previous.training_info?.status!==info.status&&info.status==='completed'){modelKey='';refreshModels();refreshTrainingResults(true);toast('训练完成，已在下方显示训练结果图。');}
 if(previous.training_info?.status!==info.status&&info.status==='failed')refreshTrainingResults();
 if(previous.validation_info?.status!==next.validation_info?.status&&next.validation_info?.status==='completed'){refreshValidationPlots();toast('验证完成，右侧显示评估指标。');}
}
function addOption(select,value,label){const option=new Option(label,value);select.add(option);return option;}

/* ---------- training progress, results and the validation page ---------- */

let trainingHistory=null;
// Ultralytics writes one results.csv row per epoch; the rendered log holds the
// rest of the story (environment, errors) but no numbers when verbose is off.
function trainingProgress(info){
 const latest=trainingHistory?.latest;
 const total=Number(state.trainingInfo?.epochs)||0;
 if(!latest||!latest.rows.length)return null;
 const columns=latest.columns;
 const index=name=>columns.findIndex(column=>column===name);
 const last=latest.rows[latest.rows.length-1];
 const value=name=>{const at=index(name);return at<0?null:Number(last[at]);};
 const at=index('epoch');
 const epoch=at<0?latest.rows.length:Number(last[at])||latest.rows.length;
 const watch=[
  ['train/box_loss','box_loss'],['train/cls_loss','cls_loss'],['train/dfl_loss','dfl_loss'],
  ['train/seg_loss','seg_loss'],['train/pose_loss','pose_loss'],['train/kobj_loss','kobj_loss'],
  ['metrics/precision(B)','precision(B)'],['metrics/recall(B)','recall(B)'],
  ['metrics/mAP50(B)','mAP50'],['metrics/mAP50-95(B)','mAP50-95'],
  ['metrics/precision(M)','precision(M)'],['metrics/mAP50(M)','mask mAP50'],['metrics/mAP50-95(M)','mask mAP50-95'],
  ['metrics/precision(P)','precision(P)'],['metrics/mAP50(P)','pose mAP50'],['metrics/mAP50-95(P)','pose mAP50-95'],
  ['metrics/accuracy_top1','top1_acc'],['metrics/accuracy_top5','top5_acc']
 ];
 const metrics=watch.map(([name,label])=>[label,value(name)]).filter(([,number])=>number!==null&&Number.isFinite(number));
 return {epoch,total:total||epoch,rows:latest.rows.length,metrics,run:latest.run};
}
function renderTrainingProgress(info){
 const lines=info.logs||[],block=$('#training-progress');
 const parsed=trainingProgress(info);
 const running=['starting','training'].includes(info.status);
 const show=running||!!parsed||info.status==='completed'||info.status==='stopped';
 block.hidden=!show;
 if(!show)return;
 const total=parsed?.total||0,epoch=parsed?.epoch||0;
 const ratio=total?Math.min(1,epoch/total):0;
 $('#training-progress-fill').style.width=(ratio*100).toFixed(1)+'%';
 // Completed runs have no live progress, so the meter describes the newest
 // recorded run instead of pretending training is happening right now.
 $('#training-progress-text').textContent=running
  ?(parsed?`第 ${epoch} / ${total||'?'} 轮 · 已完成 ${(ratio*100).toFixed(0)}% · 已记录 ${parsed.rows} 轮`:'正在准备第一轮…')
  :(parsed?`最近一次训练：共 ${parsed.rows} 轮，展示第 ${epoch} 轮指标（${parsed.run}）`:'等待训练开始');
 const strip=$('#training-metrics');strip.replaceChildren();
 for(const [label,number] of parsed?.metrics||[]){
  const cell=document.createElement('div');const strong=document.createElement('strong');const span=document.createElement('span');
  // CSV headers keep Ultralytics' English names (mAP50, mAP50-95, box_loss...).
  strong.textContent=/mAP|acc/i.test(label)?(number*100).toFixed(2)+'%':number.toFixed(4);
  span.textContent=label;cell.append(strong,span);strip.append(cell);
 }
}
let plotRequest=0,trainingPoll=null,splitKey='';
async function refreshTrainingResults(force){
 const wrap=$('#training-results'),grid=$('#training-plots');
 if(!state.project){wrap.hidden=true;trainingHistory=null;return;}
 const token=++plotRequest;
 let payload={plots:[],history:[],latest:null};
 try{payload=await api.trainingPlots();}catch{payload={plots:[],history:[],latest:null};}
 if(token!==plotRequest)return;
 trainingHistory=payload;
 const signature=(payload.plots||[]).map(entry=>entry.relative).join('|');
 if(force||signature!==grid.dataset.signature){
  grid.dataset.signature=signature;
  grid.replaceChildren();
  for(const plot of payload.plots||[]){
   const button=document.createElement('button');
   button.type='button';button.className='plot-card';button.title='点击查看大图：'+plot.name;
   const image=document.createElement('img');image.alt=plot.name;image.loading='lazy';
   const caption=document.createElement('span');caption.textContent=plotLabel(plot.name);
   button.append(image,caption);
   button.onclick=()=>openPlot(plot.relative,plotLabel(plot.name));
   grid.append(button);
   api.resultImage(plot.relative,900).then(asset=>{if(token===plotRequest&&asset?.url)image.src=asset.url;}).catch(()=>{button.remove();});
  }
 }
 wrap.hidden=!(payload.plots||[]).length;
 $('#training-results-note').textContent=payload.run?('来自 '+payload.run):'';
 // Repaint the meter now that real epoch numbers are available.
 const info=state.trainingInfo||{status:'idle',logs:[]};
 renderTrainingProgress(info);
}
function plotLabel(name){
 const clean=String(name).replace(/\.(png|jpe?g)$/i,'');
 const table={'results':'训练曲线','confusion_matrix':'混淆矩阵','confusion_matrix_normalized':'归一化混淆矩阵','PR_curve':'精确率-召回率曲线','F1_curve':'F1 曲线','P_curve':'精确率曲线','R_curve':'召回率曲线','val_batch0_pred':'验证集预测示例','val_batch0_labels':'验证集真实标注','val_batch1_pred':'预测示例 2','val_batch2_pred':'预测示例 3'};
 // Pose and segmentation runs prefix the curves with their task name.
 const key=clean.replace(/^(Box|Pose|Seg|Obb|Cls)/,'');
 const prefix=key===clean?'':clean.slice(0,clean.length-key.length);
 return (prefix?prefix+' ':'')+(table[key]||key||clean);
}
function openPlot(relative,title){
 const dialog=$('#plot-dialog');$('#plot-title').textContent=title;
 const image=$('#plot-image');image.removeAttribute('src');
 dialog.showModal();
 api.resultImage(relative,1600).then(asset=>{if(asset?.url){image.src=asset.url;$('#plot-error').textContent='';}}).catch(error=>{$('#plot-error').textContent=error.message;});
}
function validationFor(info,project){
 if(!info)return {status:'idle',logs:[]};
 if(!project)return {status:'idle',logs:[]};
 if(info.project&&info.project!==project.root)return {status:'idle',logs:[]};
 return info;
}
function renderValidation(info,project){
 const current=validationFor(info,project);
 const running=['starting','running'].includes(current.status);
 $('#validate-status').textContent={idle:'尚未运行',starting:'正在准备',running:'验证中',completed:'验证完成',failed:'验证失败',stopped:'已停止'}[current.status]||'尚未运行';
 $('#validate-run').textContent=current.run||'';
 const metrics=$('#validate-metrics');metrics.replaceChildren();
 const values=(current.metrics&&Object.keys(current.metrics).length)?current.metrics:state.validationMetrics;
 if(values)for(const [name,value] of Object.entries(values)){
  if(name==='任务')continue;
  const cell=document.createElement('div');const strong=document.createElement('strong');const label=document.createElement('span');
  // Only 0–1 ratios become percentages; counts stay counts (a folder with 6
  // pictures must not read as "600.00%").
  const isRatio=/mAP|精确率|召回率|准确率|IOU/i.test(name)&&typeof value==='number'&&value<=1;
  if(typeof value!=='number')strong.textContent=String(value);
  else if(isRatio)strong.textContent=(value*100).toFixed(2)+'%';
  else if(Number.isInteger(value))strong.textContent=String(value);
  else strong.textContent=value.toFixed(2);
  label.textContent=name;cell.append(strong,label);metrics.append(cell);
 }
 const logs=$('#validate-log');const auto=$('#validate-autoscroll').checked;const atEnd=logs.scrollTop+logs.clientHeight>=logs.scrollHeight-30;
 logs.textContent=current.logs?.length?current.logs.join('\n'):'验证开始后在这里显示真实日志。';
 if(auto||atEnd)logs.scrollTop=logs.scrollHeight;
 $('#validate-start').disabled=running||!state.ready||!project||$('#validate-model').options.length===0;
 $('#validate-stop').disabled=!running;
}
async function refreshValidationPlots(){
 if(!state.project){$('#validate-plots-wrap').hidden=true;$('#validate-history-wrap').hidden=true;return;}
 const records=await api.validationHistory().catch(()=>[]);
 const history=$('#validate-history'),wrap=$('#validate-history-wrap');
 history.replaceChildren();
 wrap.hidden=!records.length;
 for(const record of records.slice(0,8)){
  const row=document.createElement('div');row.className='history-row';
  const when=document.createElement('span');when.textContent=(record.at||record.id)+' · '+(record.weights?record.weights.split(/[\\/]/).pop():'');
  const score=document.createElement('strong');
  const metrics=record.metrics||{};
  const headline=metrics['mAP@0.5']??metrics['掩膜 mAP@0.5']??metrics['关键点 mAP@0.5']??metrics['旋转框 mAP@0.5']??metrics['Top-1 准确率'];
  score.textContent=headline!=null?('mAP/准确率 '+(headline*100).toFixed(1)+'%'):'—';
  const open=document.createElement('button');open.type='button';open.className='text-button';open.textContent='查看结果图';
  open.onclick=()=>{state.validationMetrics=metrics;renderValidation(state.validationInfo,state.project);showValidationPlots(record);};
  row.append(when,score,open);history.append(row);
 }
 const latest=records[0];
 if(latest)showValidationPlots(latest);
}
async function showValidationPlots(record){
 const wrap=$('#validate-plots-wrap'),grid=$('#validate-plots');
 const names=Array.isArray(record?.plots)?record.plots.map(entry=>typeof entry==='string'?entry:entry.name):[];
 if(!names.length){wrap.hidden=true;return;}
 grid.replaceChildren();wrap.hidden=false;
 for(const name of names){
  const relative='validation/'+record.id+'/'+name;
  const button=document.createElement('button');button.type='button';button.className='plot-card';button.title='点击查看大图：'+name;
  const image=document.createElement('img');image.alt=name;image.loading='lazy';
  const caption=document.createElement('span');caption.textContent=plotLabel(name);
  button.append(image,caption);button.onclick=()=>openPlot(relative,plotLabel(name));
  grid.append(button);
  api.resultImage(relative,900).then(asset=>{if(asset?.url)image.src=asset.url;}).catch(()=>{button.remove();});
 }
}

async function refreshModels(){
 const generation=++modelGeneration,task=state.project?.task||'detect',context=JSON.stringify([state.project?.root,task]);
 const records=await api.models();if(generation!==modelGeneration||context!==JSON.stringify([state.project?.root,state.project?.task||'detect']))return;
 const sameContext=modelsContext===context;modelsContext=context;
 const suffix={detect:'',segment:'-seg',pose:'-pose',obb:'-obb',classify:'-cls'}[task];
 const key=JSON.stringify([state.project?.root,task,records]);if(key===modelKey)return;modelKey=key;
 for(const id of ['#train-model','#predict-model']){const select=$(id),previous=sameContext?select.value:'',existing=[...select.options].find(o=>o.value===previous);select.replaceChildren();const customPose=task==='pose'&&state.project.template?.preset!=='coco17';if(id==='#predict-model'&&customPose){const prompt=addOption(select,'','请选择骨点匹配的本地或已训练模型');prompt.disabled=true;}else for(const base of ['yolov8n','yolov8s','yolo11n','yolo11s','yolo26n'])addOption(select,base+suffix+'.pt',base+suffix+(task==='pose'?' · 人体预训练，可用于迁移训练':' · 预训练'));for(const record of records)addOption(select,record.weights,record.name+' · 本项目模型');if(existing&&previous&&![...select.options].some(o=>o.value===previous))select.add(existing);if([...select.options].some(o=>o.value===previous))select.value=previous;}
 // Validation compares project models against the frozen split; only this
 // project's own trained weights make sense there.
 const validate=$('#validate-model'),kept=validate.value;
 validate.replaceChildren();
 if(!records.length){const prompt=addOption(validate,'','还没有本项目训练出的模型');prompt.disabled=true;}
 else{
  const prompt=addOption(validate,'','请选择要验证的模型');prompt.disabled=true;
  for(const record of records)addOption(validate,record.weights,record.name+' · 本项目模型');
  if(kept&&[...validate.options].some(o=>o.value===kept))validate.value=kept;else validate.value=records[0].weights;
 }
 const list=$('#trained-models');list.replaceChildren();if(!records.length){const p=document.createElement('p');p.className='muted';p.textContent='训练完成后，best.pt 会出现在这里。';list.append(p);}
 for(const record of records){const row=document.createElement('div');row.className='model-row';const name=document.createElement('span');name.textContent=record.name;name.title=record.weights;const use=document.createElement('button');use.textContent='用于预标注';use.onclick=async()=>{$('#predict-model').value=record.weights;await rpc('mode',{mode:'trained'});go('models');};row.append(name,use);list.append(row);}
}
async function localWeights(select){const path=await api.choose('weights');if(path){addOption($(select),path,path.split(/[\\/]/).pop()+' · 本地权重');$(select).value=path;}}
function chooseTask(task){newTask=task;newShape=(taskShapes[task]||taskShapes.detect)[0].id;document.querySelectorAll('[data-task]').forEach(b=>b.classList.toggle('selected',b.dataset.task===task));$('#new-task-hint').textContent=taskHints[task];$('#new-pose-fields').hidden=task!=='pose';if(task==='pose'&&['目标','person','dog'].includes($('#new-classes').value))$('#new-classes').value=$('#new-preset').value==='dog'?'dog':'person';renderShapes();}
function renderShapes(){
 const choices=taskShapes[newTask]||taskShapes.detect,row=$('#shape-picker');
 row.replaceChildren();
 for(const choice of choices){
  const button=document.createElement('button');
  button.type='button';button.dataset.shape=choice.id;button.className=choice.id===newShape?'selected':'';
  button.innerHTML=(window.workflowIcon?.(choice.icon)||'')+'<b>'+choice.name+'</b>';
  button.onclick=()=>{newShape=choice.id;renderShapes();};
  row.append(button);
 }
 const picked=choices.find(choice=>choice.id===newShape)||choices[0];
 $('#new-shape-hint').textContent=picked.hint;
 // Classification has exactly one shape, so the whole step is collapsed and the
 // remaining steps renumber to stay sequential.
 const showShape=choices.length>1;
 $('#new-shape-row').hidden=!showShape;
 $('#step-classes').firstElementChild.textContent=showShape?'3':'2';
 // Detection uses the plain detector for boxes, but a rotated box needs the OBB
 // task and a polygon needs segmentation, so the task follows the shape.
 const implied={rotation:'obb',polygon:newTask==='detect'?'segment':newTask,brush:'segment',circle:newTask==='segment'?'segment':newTask};
 const impliedTask=implied[picked.id];
 const note=$('#new-shape-task');
 if(note){
  const changed=impliedTask&&impliedTask!==newTask;
  note.hidden=!changed;
  if(changed)note.textContent='“'+picked.name+'”会用'+taskNames[impliedTask]+'方式训练，创建后项目任务自动为'+taskNames[impliedTask]+'。';
 }
}
async function showNew(task='detect'){await editor.save();chooseTask(task);$('#project-error').textContent='';if(!projectsHome){const defaults=await api.defaults();projectsHome=defaults.projects;}if(!newRootEdited)$('#new-root').value=projectsHome+'/'+($('#new-name').value.trim().replace(/[\\/:*?"<>|]/g,'_')||'我的项目');$('#project-dialog').showModal();}
async function openProject(){try{await editor.save();const path=await api.choose('project');if(path){await rpc('open_project',{path});await go('data');}}catch(e){toast(e.message);}}
const pending=new Option('待审核（含未标注）','pending');$('#image-filter').add(pending);
document.querySelectorAll('[data-window]').forEach(b=>b.onclick=()=>api.window(b.dataset.window));
// Only the theme buttons, never the root element: <html> also carries a
// data-theme attribute, and attaching the handler to it made every click in the
// app re-apply a theme — which read as "picking dark snaps back to light".
document.querySelectorAll('button[data-theme]').forEach(b=>b.onclick=()=>api.theme(b.dataset.theme));
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>go(b.dataset.page));
document.querySelectorAll('[data-flow]').forEach(b=>b.onclick=async()=>{try{if(!state.project){await showNew();return;}await editor.save();await rpc('mode',{mode:b.dataset.flow});await go({manual:'editor',pretrained:'models',trained:'train'}[b.dataset.flow]);}catch(e){toast(e.message);}});
$('#mode').onchange=async()=>{try{if(!state.project){await showNew();return;}await editor.save();const mode=$('#mode').value;await rpc('mode',{mode});await go({manual:'editor',pretrained:'models',trained:'train'}[mode]);}catch(e){toast(e.message);}};
for(const id of ['#new-project','#new-project-main'])$(id).onclick=()=>showNew().catch(e=>toast(e.message));
for(const id of ['#open-project','#open-project-main'])$(id).onclick=openProject;
$('#close-project-dialog').onclick=()=>$('#project-dialog').close();
document.querySelectorAll('[data-task]').forEach(b=>b.onclick=()=>chooseTask(b.dataset.task));
$('#new-name').oninput=()=>{if(!newRootEdited)$('#new-root').value=projectsHome+'/'+($('#new-name').value.trim().replace(/[\\/:*?"<>|]/g,'_')||'我的项目');};
$('#new-root').oninput=()=>newRootEdited=true;
for(const [id,kind,target] of [['#choose-source','source','#new-source'],['#choose-root','root','#new-root']])$(id).onclick=async()=>{const path=await api.choose(kind);if(path){$(target).value=path;if(kind==='root')newRootEdited=true;}};
$('#new-preset').onchange=()=>{$('#custom-template').hidden=$('#new-preset').value!=='custom';if(['目标','person','dog'].includes($('#new-classes').value))$('#new-classes').value=$('#new-preset').value==='dog'?'dog':'person';};
function pairs(text){return text.trim()?text.split(/[,，]/).filter(s=>s.trim()).map(s=>{const match=s.trim().match(/^(\d+)\s*-\s*(\d+)$/);if(!match)throw new Error('连接或对称请使用编号，例如 1-2, 2-3');return [Number(match[1])-1,Number(match[2])-1];}):[];}
$('#project-form').onsubmit=async e=>{e.preventDefault();$('#project-error').textContent='';$('#create-project').disabled=true;$('#create-project').textContent='正在导入副本…';try{const args={name:$('#new-name').value.trim(),task:newTask,classes:$('#new-classes').value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean),root:$('#new-root').value.trim(),source:$('#new-source').value.trim(),preset:$('#new-preset').value};if(newTask==='pose'&&args.preset==='custom')args.template={points:$('#new-points').value.split('\n').map(s=>s.trim()).filter(Boolean),edges:pairs($('#new-edges').value),pairs:pairs($('#new-pairs').value)};await rpc('create_project',args);$('#project-dialog').close();await api.state().then(update);paging.page=0;await loadImages();await go('editor');toast('项目已建立，原始图片保留。');}catch(error){$('#project-error').textContent=error.message;}finally{$('#create-project').disabled=false;$('#create-project').textContent='创建项目并开始标注';}};
$('#add-class').onclick=()=>{if(!state.project)return toast('请先建立项目。');$('#text-value').value='';$('#text-error').textContent='';$('#text-dialog').showModal();};
$('#auto-approve').checked=autoApprove();
$('#auto-approve').onchange=e=>{setAutoApprove(e.target.checked);toast(e.target.checked?'“保存草稿”现在会直接标记为已审核。':'已改为只保存草稿，需要手动确认审核。');};
$('#text-cancel').onclick=()=>$('#text-dialog').close();
$('#text-form').onsubmit=async e=>{e.preventDefault();try{const name=$('#text-value').value.trim();await rpc('add_class',{name});await api.state().then(update);editor.activeClass=name;$('#active-class').value=name;$('#text-dialog').close();toast('已追加类别：'+name);}catch(error){$('#text-error').textContent=error.message;}};
$('#image-filter').onchange=()=>{paging.page=0;loadImages();};$('#image-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{paging.page=0;loadImages();},250);};$('#refresh-images').onclick=loadImages;
$('#prev-page').onclick=()=>{paging.page--;loadImages();};$('#next-page').onclick=()=>{paging.page++;loadImages();};$('#page-size').onchange=()=>{paging.page=0;loadImages();};$('#editor-prev').onclick=()=>navigate(-1);$('#editor-next').onclick=()=>navigate(1);
for(const id of ['#split-mode','#split-ratio','#split-count','#split-seed'])$(id).onchange=()=>refreshSplitPreview();
function splitArgs(){return {split_mode:$('#split-mode').value,split_ratio:Number($('#split-ratio').value),split_count:Number($('#split-count').value),split_seed:Number($('#split-seed').value)};}
// The state publisher runs about once a second, so this must stay idempotent: an
// earlier "newest call wins" guard rejected every write because each update
// bumped the counter while the previous response was still in flight.
async function refreshSplitPreview(){
 if(!state.project){$('#split-summary').textContent='尚未打开项目';return;}
 if(!state.ready)return;
 const key=JSON.stringify([state.project.root,splitArgs()]);
 if(key===splitKey)return;
 try{
  const preview=await rpc('split_preview',splitArgs());
  if(!state.project||JSON.stringify([state.project.root,splitArgs()])!==key)return;
  splitKey=key;
  $('#split-summary').textContent=preview.ready?('训练 '+preview.train+' 张 · 验证 '+preview.val+' 张（已审核 '+preview.images+' 张）'):('已审核图片不足，当前 '+preview.images+' 张');
  $('#split-summary').title=preview.ready?'':'至少需要 2 张内容不同的已审核图片';
 }catch(error){$('#split-summary').textContent=error.message;}
}
$('#training-form').onsubmit=async e=>{e.preventDefault();trainingPending=true;$('#train-start').disabled=true;$('#training-status').textContent='准备已审核数据快照…';try{await editor.save();const args={model:$('#train-model').value,device:$('#train-device').value,lr0:Number($('#train-lr0').value),optimizer:$('#train-optimizer').value,amp:$('#train-amp').checked};for(const name of ['epochs','batch','imgsz','workers','patience'])args[name]=Number($('#train-'+name).value);for(const [id,key] of [['lrf','lrf'],['weight-decay','weight_decay'],['momentum','momentum'],['iou','iou'],['confidence','conf'],['mosaic','mosaic'],['mixup','mixup'],['scale','scale'],['translate','translate'],['fliplr','fliplr'],['hsv-h','hsv_h'],['hsv-s','hsv_s'],['hsv-v','hsv_v']])args[key]=Number($('#train-'+id).value);Object.assign(args,splitArgs());await rpc('start_training',args);toast('训练已启动，使用已审核数据快照。');}catch(error){toast(error.message);}finally{trainingPending=false;api.state().then(update);}};
$('#train-stop').onclick=async()=>{if(confirm('停止当前训练？已保存的检查点会保留。'))try{await rpc('stop_training');}catch(e){toast(e.message);}};
$('#predict-form').onsubmit=async e=>{e.preventDefault();try{await editor.save();await rpc('predict',{weights:$('#predict-model').value,device:$('#predict-device').value,confidence:Number($('#predict-confidence').value),aliases:$('#predict-aliases').value});toast('已启动批量预标注，结果作为候选保存。');}catch(error){toast(error.message);}};
$('#predict-stop').onclick=()=>rpc('stop_predict').catch(e=>toast(e.message));
$('#predict-local').onclick=()=>localWeights('#predict-model');$('#train-local').onclick=()=>localWeights('#train-model');$('#validate-local').onclick=()=>localWeights('#validate-model');
$('#refresh-models').onclick=()=>{modelKey='';refreshModels();};$('#open-results').onclick=()=>api.results();
$('#training-clear').onclick=()=>{$('#training-log').textContent='（已清空显示，磁盘上的训练日志不受影响。）';};
$('#training-autoscroll').onchange=()=>{if($('#training-autoscroll').checked){const logs=$('#training-log');logs.scrollTop=logs.scrollHeight;}};
// Shared by the form and by the toolbar, so validation can also be started
// without going through a submit event.
async function runValidation(){
 await editor.save();
 const source=$('#validate-source').value;
 if(source!=='frozen'&&!$('#validate-path').value.trim())throw new Error('请先选择要验证的文件夹、图片或视频。');
 const result=await rpc('start_validation',{weights:$('#validate-model').value,device:$('#validate-device').value,batch:Number($('#validate-batch').value),imgsz:Number($('#validate-imgsz').value),confidence:Number($('#validate-confidence').value),iou:Number($('#validate-iou').value),plots:$('#validate-plots-toggle').checked,source,custom_path:source==='frozen'?'':$('#validate-path').value.trim(),video_step:Number($('#validate-step').value)});
 state.validationMetrics=null;
 return result;
}
$('#validate-form').onsubmit=async e=>{
 e.preventDefault();
 try{
  await runValidation();
  toast('验证已启动，'+(($('#validate-source').value==='frozen')?'完成后显示 mAP 等指标。':'完成后显示检出统计与预测图。'));
 }catch(error){toast(error.message);}
 finally{api.state().then(update);}
};
$('#validate-start').onclick=e=>{e.preventDefault();$('#validate-form').requestSubmit();};
// Switching the validation target shows only the inputs it needs.
$('#validate-source').onchange=()=>{
 const source=$('#validate-source').value;
 $('#validate-path-row').hidden=source==='frozen';
 $('#validate-step-row').hidden=source!=='video';
 $('#validate-path').placeholder={folder:'选择包含图片的文件夹',image:'选择一张图片',video:'选择一个视频文件'}[source]||'';
 $('#validate-path').value='';
};
$('#validate-choose').onclick=async()=>{
 const source=$('#validate-source').value;
 if(source==='folder'){const path=await api.choose('source');if(path)$('#validate-path').value=path;return;}
 const path=await api.choose(source==='video'?'video':'image');if(path)$('#validate-path').value=path;
};
$('#validate-stop').onclick=async()=>{if(confirm('停止当前验证？'))try{await rpc('stop_validation');}catch(e){toast(e.message);}};
$('#validate-refresh').onclick=()=>{refreshValidationPlots();refreshTrainingResults(true);};
$('#plot-close').onclick=()=>$('#plot-dialog').close();
// Explain the alias format using the classes the selected model actually knows.
$('#predict-alias-help').onclick=async()=>{
 const weights=$('#predict-model').value;const box=$('#predict-alias-preview');box.hidden=false;
 if(!weights){box.textContent='请先选择一个模型，再查看它的类别名。';return;}
 box.textContent='正在读取模型类别名…';
 try{
  const names=await rpc('model_classes',{weights});
  const project=state.project?.classes||[];
  const suggested=names.slice(0,6).map(name=>name+'='+(project.includes(name)?name:project[0]||'你的类别名')).join('; ');
  box.textContent='模型类别名：'+names.join('、')+'。项目类别：'+project.join('、')+'。同名会自动对应；需要改名时按这样填写：'+suggested;
 }catch(error){box.textContent='读取失败：'+error.message;}
};
$('#pose-settings').onclick=()=>{const t=state.project?.template;if(t)toast((t.display||t.points).map((name,i)=>(i+1)+'. '+name).join('；'));};
$('#retry').onclick=()=>api.retry();$('#logs').onclick=()=>api.logs();

/* ---------- plain-language help for the confusing parameters ---------- */
const HELP={
 split:{title:'训练 / 验证划分',body:[
  ['为什么要划分','模型只有在没见过的图片上才知道自己行不行。所以已审核的图片会被分成两部分：大部分用来“学”（训练集），留一小部分不参与学习，只用来打分（验证集）。'],
  ['划分方式','按比例：验证集占已审核图片的百分比，例如 20%。按数量：直接指定验证集有几张，例如 1 张。数据很少时用“按数量”更好控制。'],
  ['验证集比例 %','填 20 表示每 5 张已审核图片里留 1 张做验证。范围 5–50%。验证集太少分数会飘，太多则模型学得不够。'],
  ['验证集数量','按数量方式下验证集固定几张。只有 6 张已审核图片时，留 1 张验证、5 张训练是合理的。'],
  ['划分随机种子','同样的种子给同样的划分。想换一批图片做验证就改这个数字；不改则多次训练的结果可以互相比较。'],
  ['什么时候冻结','点“开始训练”时才写入 splits.json 并固定下来。之后新审核通过的图片会自动进入训练集，不会打乱已有的验证集。'],
  ['提示','验证集里不要出现和训练集几乎一样的图片（例如同一张图的增强副本），否则验证分数会虚高。']
 ]},
 train:{title:'训练参数',body:[
  ['运行设备 device','cpu 用处理器，慢但不挑环境；0 用第一块 NVIDIA 显卡，快。写 0 就必须有可用的 CUDA 驱动。'],
  ['训练轮数 epochs','整个训练集被完整学几遍。100 是常用起点；数据少时 50–200 都行，有早停不会白跑。'],
  ['每批图片 batch','一次同时处理几张图。显存不足就调小（2 或 4），显存富裕可以调大以加快训练。'],
  ['图片尺寸 imgsz','训练时把图片缩放到多大。640 是 YOLO 默认值；小目标多可以调到 960 或 1280，但更吃显存。'],
  ['初始学习率 lr0','每次更新模型时迈的步子大小。0.01 是 SGD 的常用值；太大容易不收敛，太小则学得很慢。'],
  ['优化器 optimizer','决定怎么根据误差调整权重。SGD 通用稳定；Adam/AdamW 在小数据上有时收敛更快；auto 交给 Ultralytics 自己挑。'],
  ['最终学习率系数 lrf','学习率在训练结束时降到初始值的多少倍。0.01 表示最后降到 1%。'],
  ['权重衰减 weight_decay','抑制模型把训练集“背下来”。数值越大，正则化越强。'],
  ['动量 momentum','沿用上一步的方向，让训练更平稳、少抖动。'],
  ['Mosaic mosaic','把 4 张图拼成 1 张来训练，明显提升小目标与遮挡的鲁棒性。想关掉填 0。'],
  ['MixUp mixup','把两张图按透明度叠加，属于更强的增强，通常只在数据很少时开一点。'],
  ['随机缩放 scale','随机放大缩小图片，模拟远近变化。0.5 表示最多缩放 ±50%。'],
  ['随机平移 translate','随机上下左右移动图片，模拟位置偏移。0.1 表示最多平移 ±10%。'],
  ['左右翻转 fliplr','一半概率左右镜像。有左右之分的任务（例如姿态的左右手）不能乱开；本项目在姿态且未设置左右配对时会自动关闭。'],
  ['HSV 色调/饱和度/明度 hsv_h / hsv_s / hsv_v','在色调、饱和度、明暗上做随机扰动，模拟不同光照。'],
  ['早停轮数 patience','连续这么多轮没有提升就提前停止，避免白跑和过拟合。'],
  ['数据增强要不要动','数据多且真实时保持默认即可；样本很少、或现场光照与尺度差异大时再有针对性地加大。参数名与 Ultralytics 一致，可在训练结果的 args.yaml 里复核。']
 ]},
 validate:{title:'模型验证',body:[
  ['验证在做什么','拿一份模型没学过的数据跑一遍，算出 mAP、精确率、召回率，并生成混淆矩阵和预测示例，判断模型到底能不能用。'],
  ['和训练时的区别','训练里的验证是顺带打分；这里是拿固定数据独立复测，方便比较不同权重、不同轮数的模型。'],
  ['验证对象怎么选','· 训练时冻结的验证集：和训练分数同一口径，最适合横向比较。\n· 自选文件夹：把别的项目或新拍的图片复制一份进来当测试集，原文件不动。\n· 单张图片：快速看一张图的预测效果。\n· 视频：按固定间隔抽帧后逐帧预测，适合看连续场景。'],
  ['指标怎么看','mAP50 越高越好；mAP50-95 更严格，会把框的贴合程度也算进去。精确率高说明误报少，召回率高说明漏检少，两者常此消彼长，按任务取舍。'],
  ['置信度阈值 conf','模型认为“这里有目标”的最低把握，默认 0.25。调高只保留很确定的框，误报少但容易漏；调低框更多，漏检少但误报多。评估模型真实水平时保持默认，便于和别人对比。'],
  ['IoU 阈值 iou','判定“两个框是同一个目标”的重叠比例门槛，默认 0.7。重叠超过这个比例就只保留分数最高的那个（非极大值抑制）。\n· 目标密集、互相遮挡（人群、货架）：调到 0.4~0.6，避免把挨在一起的目标合并掉。\n· 目标大而稀疏：保持 0.7 或略高。\n它只影响去重，不改变模型本身；换一个 IoU 复测指标就会变，所以两次对比请用同一个值。'],
  ['注意','验证结果只写入项目的 validation 目录，不会改动任何标注；本次使用的 conf 与 iou 会记录在结果里，方便对比两次验证。']
 ]},
 iou:{title:'IoU 阈值是什么',body:[
  ['一句话','判定“两个框指的是同一个目标”的重叠比例门槛，默认 0.7。'],
  ['它管什么','模型一次会吐出很多重叠的框。IoU 超过阈值的那些被认为是同一个目标，只保留分数最高的一个（非极大值抑制）。它只负责去重，不改变模型本身。'],
  ['调高会怎样','0.8~0.95：更容忍重叠，框更多更密。目标挨得近时容易一个目标留好几个框。'],
  ['调低会怎样','0.3~0.5：合并更激进，框更干净。但人群、货架、密集小目标可能被误合并，召回率下降。'],
  ['怎么选','默认 0.7 适合大多数情况。目标密集或遮挡严重就试 0.5 左右；目标大而稀疏可保持 0.7 以上。'],
  ['注意','换一个 IoU，指标数字就会变。比较两次验证结果时请固定在同一个值。本次验证用的 conf 与 iou 会写进结果文件。']
 ]},
 confidence:{title:'置信度阈值是什么',body:[
  ['一句话','模型认为“这里确实有目标”的最低把握，默认 0.25。低于这个分数的框会被丢掉。'],
  ['调高会怎样','0.5 以上：只留下很确定的框，误报少，但漏检变多。'],
  ['调低会怎样','0.1 左右：框更多、漏检少，但误报和重复框增加。'],
  ['和 IoU 的区别','置信度管“这个框要不要”，IoU 管“这几个框是不是同一个”。两者独立，都会影响最终看到的结果。'],
  ['怎么选','评估模型真实水平时保持默认 0.25，方便和别人或论文对比；实际部署时再按“宁可误报还是宁可漏检”调整。']
 ]},
 aliases:{title:'类别映射怎么写',body:[
  ['什么时候需要','模型的类别名和你的项目类别名不一样时才要填。名字完全一样会自动对应，留空即可。'],
  ['格式','模型类别名=项目类别名，多组之间用分号 ;（中文分号；也行）隔开。等号两边不要写逗号。'],
  ['示例','模型认 cat、dog，你的项目叫 猫、狗，就填：cat=猫; dog=狗'],
  ['怎么知道模型有哪些类别','点旁边的“查看模型类别名”，会读取权重里内置的类别名，并给出可以直接粘贴的建议。']
 ]}
};
function openHelp(key){
 const entry=HELP[key];
 if(!entry)return;
 $('#help-title').textContent=entry.title;
 const body=$('#help-body');body.replaceChildren();
 for(const [heading,text] of entry.body){
  const card=document.createElement('div');card.className='help-card';
  const title=document.createElement('strong');title.textContent=heading;
  const paragraph=document.createElement('p');paragraph.textContent=text;
  card.append(title,paragraph);body.append(card);
 }
 $('#help-dialog').showModal();
}
document.querySelectorAll('[data-help]').forEach(button=>{
 button.onclick=event=>{event.preventDefault();event.stopPropagation();openHelp(button.dataset.help);};
});
$('#help-close').onclick=()=>$('#help-dialog').close();
api.onState(update);api.state().then(update);
if(api.onBeforeClose)api.onBeforeClose(async()=>({draft:(editor.dirty||editor.pending.length)&&editor.data?{project:editor.project?.root,name:editor.name,annotation:structuredClone(editor.data),base_hash:editor.baseHash,pending:structuredClone(editor.pending)}:null}));
// Keep the desktop title bar operable while a project/category form is open.
const scrim=document.createElement('div');scrim.id='dialog-scrim';scrim.hidden=true;document.body.append(scrim);
for(const form of document.querySelectorAll('dialog')){
 form.showModal=function(){this.show();scrim.hidden=false;document.querySelector('main').inert=true;document.querySelector('.sidebar').inert=true;this.querySelector('input,button')?.focus();};
 form.addEventListener('close',()=>{const open=!!document.querySelector('dialog[open]');scrim.hidden=!open;document.querySelector('main').inert=open;document.querySelector('.sidebar').inert=open;});
}
document.addEventListener('keydown',event=>{if(event.key==='Escape'){const form=document.querySelector('dialog[open]');if(form)form.close();}});
/* Global shortcuts. Editor-local keys (V/R/1-9/Ctrl+S/Ctrl+Z) live in
   editor.js; these cover page switching and working through the image list. */
document.addEventListener('keydown',event=>{
 const typing=/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||event.target.isContentEditable;
 const dialogOpen=!!document.querySelector('dialog[open]');
 const meta=event.ctrlKey||event.metaKey;
 if(meta&&!event.shiftKey&&!typing&&!dialogOpen){
  const map={'1':'data','2':'editor','3':'models','4':'review','5':'train','6':'validate'};
  if(map[event.key]){event.preventDefault();go(map[event.key]);return;}
 }
 if(typing||dialogOpen)return;
 const onEditor=page==='editor';
 const onList=page==='data';
 if(!onEditor&&!onList)return;
 // ↑/↓ and PageUp/PageDown walk the images; Home/End jump to the ends.
 if(onEditor){
  if(event.key==='ArrowUp'||event.key==='PageUp'){event.preventDefault();navigate(-1);return;}
  if(event.key==='ArrowDown'||event.key==='PageDown'){event.preventDefault();navigate(1);return;}
  if(event.key==='Home'){event.preventDefault();jumpTo('first');return;}
  if(event.key==='End'){event.preventDefault();jumpTo('last');return;}
  if(event.key==='Enter'){event.preventDefault();editor.approve();return;}
  if(meta&&event.key.toLowerCase()==='s'){event.preventDefault();editor.save().then(()=>toast('草稿已保存。')).catch(e=>toast(e.message));return;}
 }
 if(onList){
  if(event.key==='+'||event.key==='='){event.preventDefault();showNew().catch(e=>toast(e.message));return;}
  if(event.key==='r'&&!meta){event.preventDefault();loadImages();return;}
 }
});
window.addEventListener('unhandledrejection',event=>{event.preventDefault();toast(event.reason?.message||String(event.reason));});

