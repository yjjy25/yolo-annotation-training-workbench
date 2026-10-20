/* Keep the real paths separate from the batch summary shown to the user. */
window.createVideoSelection=prefix=>{
 let paths=[];
 const input=$('#'+prefix+'-path');
 function set(value){
  paths=[...new Set((Array.isArray(value)?value:[value]).filter(p=>typeof p==='string'&&p.trim()))];
  input.value=paths.length>1?`已选择 ${paths.length} 个视频：${paths.map(p=>p.split(/[\\/]/).pop()).join('、')}`:paths[0]||'';
  input.readOnly=paths.length>1;
 }
 input.addEventListener('input',()=>{paths=[];});
 for(const [suffix,kind] of [['choose','videos'],['choose-all','video-folder']])$('#'+prefix+'-'+suffix).onclick=async()=>{
  try{const chosen=await api.choose(kind);if(chosen===null)return;if(!chosen.length){toast('所选文件夹中没有支持的视频。');return;}set(chosen);}catch(e){toast(e.message);}
 };
 return {set,get:()=>paths.length?[...paths]:[input.value.trim()].filter(Boolean)};
};
