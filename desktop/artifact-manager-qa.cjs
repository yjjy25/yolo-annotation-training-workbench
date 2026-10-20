module.exports=async({win,app,backend,request,ready})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{nativeImage}=require('electron');
 const folder=process.env.XAL_QA_ARTIFACTS_ROOT,report={checks:[],errors:[]};
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);};
 const wait=async fn=>{const end=Date.now()+40000;while(Date.now()<end){if(await fn())return;await pause(100);}throw new Error('UI timeout');};
 const shot=async name=>{await pause(200);fs.writeFileSync(path.join(folder,name),(await win.webContents.capturePage()).toPNG());};
 const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.artifactManager'));win.show();
  const root=path.join(folder,'项目');await request('create_project',{root,name:'模型与验证结果管理',task:'detect',classes:['object']});await ev('api.state().then(update)');
  for(const run of ['train-a','train-b']){write(path.join(root,'runs',run,'weights','best.pt'),'best-'+run);write(path.join(root,'runs',run,'weights','last.pt'),'last-'+run);write(path.join(root,'runs',run,'results.csv'),'epoch,map\n1,0.5');}
  write(path.join(root,'models','local.pt'),'local');write(path.join(root,'models','local.workflow.json'),JSON.stringify({template:'test'}));
  const external=path.join(folder,'external.pt');write(external,'external-original');
  const png=nativeImage.createFromPath(path.join(__dirname,'icon.png')).resize({width:128,height:128}).toPNG();
  for(let i=0;i<10;i++){const id='val-'+String(i).padStart(2,'0');write(path.join(root,'validation',id,'metrics.json'),JSON.stringify({id,at:'2026-10-20 '+String(10+i).padStart(2,'0')+':00',weights:'best.pt',metrics:{'mAP@0.5':i/20},plots:['results.png']}));write(path.join(root,'validation',id,'results.png'),png);}
  await ev("modelKey='';refreshModels()");await ev("go('models')");
  check('project model manager lists trained and imported PT weights',await ev("$('#model-manager-list').querySelectorAll('.managed-model-row').length===3"));
  await ev("$('#model-manager-jump').click();void 0");await pause(450);await shot('model-manager.png');await ev("go('train')");await ev("$('#trained-models .artifact-select').click();$('#trained-model-delete').click();void 0");await wait(()=>ev("$('#artifact-delete-dialog').open"));
  check('model deletion identifies the exact project weight directory',await ev("$('#artifact-delete-list').textContent.includes('runs')&&$('#artifact-delete-detail').textContent.includes('best.pt / last.pt')"));
  await ev("$('#artifact-delete-dialog').close('cancel')");await pause(150);check('cancelling leaves model weights intact',fs.existsSync(path.join(root,'runs','train-b','weights','best.pt')));
  await ev("$('#trained-model-delete').click();void 0");await wait(()=>ev("$('#artifact-delete-dialog').open"));const deletedPath=await ev("$('#artifact-delete-list').textContent");await ev("$('#artifact-delete-confirm').click()");
  await wait(()=>ev("$('#trained-models').querySelectorAll('.model-row').length===1"));
  check('deleting trained model archives weights and preserves training logs',!fs.existsSync(deletedPath)&&fs.existsSync(path.join(path.dirname(deletedPath),'results.csv')));
  check('deleted weights disappear from every model selector',await ev(`['train-model','predict-model','validate-model','export-model'].every(id=>![...$('#'+id).options].some(o=>o.value.startsWith(${JSON.stringify(deletedPath)})))`));
  await ev("go('models')");await wait(()=>ev("$('#model-manager-list').querySelectorAll('.managed-model-row').length===2"));
  await ev("[...document.querySelectorAll('#model-manager-list .artifact-select')].find(e=>e.dataset.artifactKey==='models/local.pt').click();$('#model-manager-delete').click();void 0");await wait(()=>ev("$('#artifact-delete-dialog').open"));await ev("$('#artifact-delete-confirm').click()");
  await wait(()=>ev("$('#model-manager-list').querySelectorAll('.managed-model-row').length===1"));
  const modelArchives=fs.readdirSync(path.join(root,'removed','models'));check('imported PT model and metadata remain recoverable',modelArchives.some(dir=>fs.existsSync(path.join(root,'removed','models',dir,'models','local.pt'))&&fs.existsSync(path.join(root,'removed','models',dir,'models','local.workflow.json'))));
  check('external original weight is untouched',fs.readFileSync(external,'utf8')==='external-original');
  await ev("go('validate')");await wait(()=>ev("$('#validate-history').querySelectorAll('.history-row').length===10"));
  check('validation history exposes records beyond the former eight-record limit',true);
  await ev("const checks=[...document.querySelectorAll('#validate-history .artifact-select')];checks[0].click();checks.at(-1).click();$('#validation-delete-selected').click();void 0");await wait(()=>ev("$('#artifact-delete-dialog').open"));
  check('validation deletion confirms exact selected count',await ev("$('#artifact-delete-title').textContent==='删除 2 条验证结果？'"));await shot('validation-delete-confirm.png');
  await ev("$('#artifact-delete-dialog').close('cancel')");await pause(100);check('cancelling validation deletion preserves results',fs.readdirSync(path.join(root,'validation')).length===10);
  await ev("$('#validation-delete-selected').click();void 0");await wait(()=>ev("$('#artifact-delete-dialog').open"));await ev("$('#artifact-delete-confirm').click()");await wait(()=>ev("$('#validate-history').querySelectorAll('.history-row').length===8"));
  check('selected validation results and plots are recoverably archived',fs.readdirSync(path.join(root,'validation')).length===8&&fs.readdirSync(path.join(root,'removed','validation')).length===1);
  check('successful validation deletions clear the selection',await ev("$('#validation-selected-count').textContent==='已选 0 条'"));
  await ev("$('#validation-select-all').click();$('#validation-delete-selected').click();void 0");await wait(()=>ev("$('#artifact-delete-dialog').open"));await ev("$('#artifact-delete-confirm').click()");await wait(()=>ev("$('#validate-history').children.length===0"));
  check('deleting the remaining validations clears results and video previews',await ev("$('#validate-history-wrap').hidden&&$('#validate-plots-wrap').hidden&&$('#validation-video-wrap').hidden&&$('#validate-metrics').children.length===0"));
  check('model and project configuration survive validation deletion',fs.existsSync(path.join(root,'project.json'))&&fs.readdirSync(path.join(root,'runs')).length===2);
  await ev("go('models')");await ev("$('#model-manager-all').click()");await request('create_project',{root:path.join(folder,'另一个项目'),name:'项目隔离',task:'detect',classes:['object']});await ev('api.state().then(update)');await ev('window.artifactManager.refreshModels()');
  check('model selection is isolated by project',await ev("$('#model-manager-count').textContent==='已选 0 个'&&$('#model-manager-delete').disabled"));
 }catch(error){report.errors.push(error.stack);try{report.debug=await ev("({page,toast:$('#toast').textContent,models:$('#model-manager-list').textContent,history:$('#validate-history').children.length})");await shot('failure.png');}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
