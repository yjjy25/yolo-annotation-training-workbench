const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('workbench',{
  state:()=>ipcRenderer.invoke('desktop:state'),
  command:(action,payload)=>ipcRenderer.invoke('desktop:command',action,payload),
  workspace:visible=>ipcRenderer.invoke('desktop:workspace',visible),
  theme:theme=>ipcRenderer.invoke('desktop:theme',theme),
  window:action=>ipcRenderer.invoke('desktop:window',action),
  retry:()=>ipcRenderer.invoke('desktop:retry'),
  logs:()=>ipcRenderer.invoke('desktop:logs'),
  images:options=>ipcRenderer.invoke('desktop:images',options),
  rpc:(method,args)=>ipcRenderer.invoke('desktop:rpc',method,args),
  choose:kind=>ipcRenderer.invoke('desktop:choose',kind),
  defaults:()=>ipcRenderer.invoke('desktop:defaults'),
  asset:(name,width)=>ipcRenderer.invoke('desktop:asset',name,width),
  recycleAsset:(root,relative,width)=>ipcRenderer.invoke('desktop:recycle-asset',root,relative,width),
  poseReference:options=>ipcRenderer.invoke('desktop:pose-reference',options),
  models:()=>ipcRenderer.invoke('desktop:models'),
  results:kind=>ipcRenderer.invoke('desktop:results',kind),
  resultImage:(relative,maxWidth)=>ipcRenderer.invoke('desktop:result-image',relative,maxWidth),
  resultVideo:relative=>ipcRenderer.invoke('desktop:result-video',relative),
  validationHistory:()=>ipcRenderer.invoke('desktop:validation-history'),
  trainingPlots:()=>ipcRenderer.invoke('desktop:plot-list'),
  diagnostics:()=>ipcRenderer.invoke('desktop:diagnostics'),
  nativeInput:data=>ipcRenderer.send('desktop:native-input',data),
  nativeView:data=>ipcRenderer.send('desktop:native-view',data),
  onNativeFrame:callback=>ipcRenderer.on('desktop:native-frame',(_event,data)=>callback(data)),
  onState:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('desktop:state',listener);return()=>ipcRenderer.removeListener('desktop:state',listener);}
  ,onBeforeClose:callback=>{ipcRenderer.on('desktop:before-close',async()=>{let payload={};try{payload=await callback();}finally{ipcRenderer.invoke('desktop:close-ready',payload);}});}
});
