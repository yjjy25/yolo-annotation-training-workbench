/* Keep saved frames reachable even after a pending queue filters them out. */
(() => {
 let root=null,trail=[],at=-1;
 function syncRoot(){if(root!==state.project?.root){root=state.project?.root;trail=[];at=-1;}}
 function align(){syncRoot();if(trail[at]?.name!==editor.name){const index=trail.findIndex(e=>e.name===editor.name);if(index>=0)at=index;else return false;}return at>=0;}
 function save(name,kind,meta={}){
  syncRoot();
  if(!align()||trail[at]?.kind!==kind){trail=[{name,kind,meta}];at=0;}
  const entry=trail[at];entry.saved=true;entry.meta={...entry.meta,...meta,name,status:'checked',annotated:!!editor.data?.shapes?.length||Object.values(editor.data?.flags||{}).some(v=>v===true),historySaved:true};
 }
 function arrive(name,kind,meta={}){
  syncRoot();if(!name)return;
  if(trail[at+1]?.name===name&&trail[at+1]?.kind===kind){at++;return;}
  trail=trail.slice(0,at+1);trail.push({name,kind,meta});at=trail.length-1;
 }
 async function visit(index){
  const entry=trail[index],projectRoot=root;if(!entry)return;
  if(entry.kind==='review')await window.videoTracking.openReview(entry.name);
  else await openImage(entry.name);
  if(projectRoot===state.project?.root&&editor.name===entry.name){at=index;renderFilmstrip();}
 }
 function navigate(step,kind){
  if(page!=='editor'||!align()||trail[at].kind!==kind)return null;
  const target=at+step;
  if(target<0){if(kind==='review'||!items.some(item=>item.name===editor.name))return Promise.resolve(toast('已是本轮可回看的第一张。'));return null;}
  if(target>=trail.length)return null;
  if(trail[target].kind!==kind)return null;
  return visit(target);
 }
 function prepareNext(){
  if(page!=='editor'||!align()||at>=trail.length-1)return undefined;
  const index=at,projectRoot=root,name=editor.name,kind=trail[at].kind;
  return async()=>{
   if(page!=='editor'||state.project?.root!==projectRoot||editor.name!==name)return;
   save(name,kind);await visit(index+1);
  };
 }
 function retained(kind){syncRoot();return trail.filter(e=>e.kind===kind&&e.saved).map(e=>({...e.meta,name:e.name}));}
 function forget(name){syncRoot();trail=trail.filter(e=>e.name!==name);at=trail.findIndex(e=>e.name===editor.name);}
 $('#editor-prev').title='上一张（A），可回看本轮已保存图片';
 $('#editor-next').title='下一张（D）';
 window.canvasNavigation={save,arrive,navigate,prepareNext,retained,forget,syncRoot};
})();
