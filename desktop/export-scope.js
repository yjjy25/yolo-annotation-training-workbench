// Which conversion belongs to the current screen, and which weights a training
// run produced. A project owns its own runs; without a project only workspace
// runs are shown, so a standalone conversion never looks like a project artifact.
(function(root){
 const normal=value=>String(value??'').replaceAll('\\','/').replace(/\/+$/,'');
 const api={
  matches(info,projectRoot){
   if(!info)return false;
   return projectRoot?info.scope!=='workspace'&&info.project===projectRoot:info.scope==='workspace';
  },
  // "train_20261107_031500" reads poorly in a dropdown; show the same instant as
  // a short local label while keeping the run name available elsewhere.
  runLabel(name){
   const text=String(name??'');
   const match=/^train[_-](\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})$/.exec(text);
   return match?`训练 ${match[2]}-${match[3]} ${match[4]}:${match[5]}`:text;
  },
  // The just-finished run's best.pt, so the training page can hand it straight to
  // the conversion page. Falls back to the newest record, else null.
  runWeights(records,run){
   const list=(Array.isArray(records)?records:[]).filter(item=>item&&item.weights);
   if(!list.length)return null;
   const target=normal(run);
   if(target){
    const match=list.find(item=>normal(item.weights).startsWith(target+'/'));
    if(match)return match.weights;
   }
   return list[0].weights;
  }
 };
 root.ExportScope=api;
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);