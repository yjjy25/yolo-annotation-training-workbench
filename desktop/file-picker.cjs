const fs=require('node:fs');
const path=require('node:path');
const videoExtensions=['mp4','avi','mov','mkv','webm','m4v'];
function collectVideos(directory){
 const result=[],pending=[directory];
 while(pending.length){
  const folder=pending.pop();
  for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
   const target=path.join(folder,entry.name);
   if(entry.isDirectory())pending.push(target);
   else if(entry.isFile()&&videoExtensions.includes(path.extname(entry.name).slice(1).toLowerCase()))result.push(target);
  }
 }
 return result.sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
}
function createFilePicker({dialog,getWindow,getProject,projects,prefs,writePrefs}){
 return async kind=>{
  if(!['source','root','project','weights','image','images','video','videos','video-folder','project-package','project-folder','project-export'].includes(kind))return null;
  const directory=['source','root','video-folder','project-folder'].includes(kind),multiple=['images','videos','video-folder'].includes(kind);
  const group=['video','videos','video-folder'].includes(kind)?'video':['source','image','images'].includes(kind)?'images':kind;
  const root=getProject()?.root,key=root||'__global__';
  const remembered=prefs.importDirectories?.[key]?.[group];
  const defaultPath=[remembered,root,projects].find(p=>typeof p==='string'&&fs.existsSync(p)&&fs.statSync(p).isDirectory());
  if(kind==='project-export'){
   const selection=await dialog.showSaveDialog(getWindow(),{title:'导出项目包',defaultPath:path.join(root?path.dirname(root):defaultPath||projects,(getProject()?.name||'项目').replace(/[\\/:*?"<>|]/g,'_')+'.zip'),filters:[{name:'项目包',extensions:['zip']}]});
   return selection.canceled?null:selection.filePath;
  }
  const options={defaultPath,properties:directory?['openDirectory','createDirectory']:multiple?['openFile','multiSelections']:['openFile']};
  if(kind==='project-package')options.filters=[{name:'项目包',extensions:['zip']}];
  else if(!directory)options.filters=['image','images'].includes(kind)?[{name:'图片',extensions:['png','jpg','jpeg','bmp','webp','tif','tiff']}]:['video','videos'].includes(kind)?[{name:'视频',extensions:videoExtensions}]:[{name:kind==='project'?'项目':'模型',extensions:[kind==='project'?'json':'pt']}];
  if(kind==='video-folder')options.title='导入文件夹全部视频（含子文件夹）';
  const selection=await dialog.showOpenDialog(getWindow(),options);
  if(selection.canceled||!selection.filePaths.length)return null;
  prefs.importDirectories??={};prefs.importDirectories[key]??={};
  prefs.importDirectories[key][group]=directory?selection.filePaths[0]:path.dirname(selection.filePaths[0]);writePrefs();
  if(kind==='video-folder')return collectVideos(selection.filePaths[0]);
  return multiple?selection.filePaths:selection.filePaths[0];
 };
}
module.exports={createFilePicker,collectVideos};
