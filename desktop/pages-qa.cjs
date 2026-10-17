/* Verifies the rewritten pages: new-project shape picker, training results panel,
 * and the validation module running a real evaluation through the UI. */
module.exports=async function({win,app,backend,request,diagnostics,ready,root}){
 const fs=require('node:fs'),path=require('node:path');
 const runtime=path.join(root,'.runtime');
 const out=path.join(runtime,'pages-check.json');
 const result={consoleErrors:[]};
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const evaluate=s=>win.webContents.executeJavaScript(s,true);
 const shot=async n=>fs.writeFileSync(path.join(runtime,n),(await win.webContents.capturePage()).toPNG());
 const wait=async(t,ms,l)=>{const e=Date.now()+ms;while(Date.now()<e){if(await t())return true;await pause(150);}throw new Error('timeout '+l);};
 try{
  win.webContents.on('console-message',(_event,details)=>{if(details?.level==='error')result.consoleErrors.push(details.message);});
  await wait(()=>Promise.resolve(ready()),60000,'ready');
  await wait(()=>evaluate('!!window.editor'),20000,'editor');
  win.show();win.focus();await pause(700);

  /* 1. new project dialog: task -> shape -> classes */
  await evaluate("go('data')");await pause(300);
  await evaluate("document.querySelector('#new-project-main').click()");
  await wait(()=>evaluate("document.querySelector('#project-dialog').open"),8000,'dialog');
  result.shapePickers={};
  for(const task of ['detect','segment','pose','obb','classify']){
   await evaluate(`document.querySelector('[data-task=${task}]').click()`);
   await pause(250);
   result.shapePickers[task]=await evaluate("({shapes:[...document.querySelectorAll('#shape-picker button')].map(b=>b.dataset.shape),chosen:document.querySelector('#shape-picker button.selected')?.dataset.shape,hint:document.querySelector('#new-shape-hint').textContent,classesLabel:document.querySelector('#new-classes').previousSibling.textContent})");
  }
  await shot('pages-newproject.png');
  await evaluate("document.querySelector('#project-dialog').close()");await pause(400);

  /* 2. training page must render progress + results blocks without errors */
  await request('open_project',{path:path.join(runtime,'smoke-v2','pose','project.json')});await pause(1800);
  await evaluate("go('train')");await pause(1200);
  result.train={...await evaluate("({progressHidden:document.querySelector('#training-progress').hidden,resultsHidden:document.querySelector('#training-results').hidden,metrics:document.querySelector('#training-metrics').children.length,logToolbar:!!document.querySelector('#training-clear')})")};
  await shot('pages-train.png');

  /* 3. validation page: model list populated, run a real evaluation */
  await evaluate("go('validate')");await pause(1500);
  result.validateBefore=await evaluate("({options:[...document.querySelector('#validate-model').options].map(o=>o.text),chosen:document.querySelector('#validate-model').value,startDisabled:document.querySelector('#validate-start').disabled})");
  const weights=path.join(runtime,'pretrained','yolov8n-pose.pt');
  await evaluate(`(()=>{const s=document.querySelector('#validate-model');s.add(new Option('QA 姿态权重',${JSON.stringify(weights)}));s.value=${JSON.stringify(weights)};})()`);
  await evaluate("document.querySelector('#validate-batch').value='2';document.querySelector('#validate-imgsz').value='64'");
  await evaluate("document.querySelector('#validate-form').requestSubmit()");
  await wait(()=>evaluate("document.querySelector('#validate-status').textContent==='验证中'||document.querySelector('#validate-status').textContent==='正在准备'"),15000,'validation start');
  await wait(()=>evaluate("['验证完成','验证失败'].includes(document.querySelector('#validate-status').textContent)"),300000,'validation finish');
  await pause(2500);
  result.validateAfter=await evaluate("({status:document.querySelector('#validate-status').textContent,metrics:[...document.querySelectorAll('#validate-metrics div')].map(d=>d.textContent),plots:document.querySelectorAll('#validate-plots .plot-card').length,history:document.querySelectorAll('#validate-history .history-row').length,plotWrapHidden:document.querySelector('#validate-plots-wrap').hidden,firstImageLoaded:(()=>{const i=document.querySelector('#validate-plots img');return i?i.naturalWidth:0;})()})");
  await shot('pages-validate.png');

  /* 4. result image opens in the viewer */
  const opened=await evaluate("(()=>{const b=document.querySelector('#validate-plots .plot-card');if(!b)return false;b.click();return true;})()");
  if(opened){await pause(2000);result.viewer=await evaluate("({open:document.querySelector('#plot-dialog').open,src:(document.querySelector('#plot-image').getAttribute('src')||'').slice(0,24),error:document.querySelector('#plot-error').textContent})");await shot('pages-viewer.png');await evaluate("document.querySelector('#plot-close').click()");}

  /* 5. optional: a very short real training run, to prove the progress meter and
        the result plots show up without the log flooding the panel. */
  if(process.env.XAL_QA_TRAIN==='1'){
   await evaluate("go('train')");await pause(1200);
   const weights=path.join(runtime,'pretrained','yolov8n-pose.pt');
   await evaluate(`(()=>{const s=document.querySelector('#train-model');s.add(new Option('QA 权重',${JSON.stringify(weights)}));s.value=${JSON.stringify(weights)};})()`);
   await evaluate("document.querySelector('#train-epochs').value='2';document.querySelector('#train-batch').value='2';document.querySelector('#train-imgsz').value='64';document.querySelector('#train-amp').checked=false");
   await evaluate("document.querySelector('#training-form').requestSubmit()");
   await wait(()=>evaluate("['starting','training'].includes(state.training_info?.status)"),30000,'training start');
   await pause(9000);
   result.trainingDuring={...await evaluate("({status:document.querySelector('#training-status').textContent,progressHidden:document.querySelector('#training-progress').hidden,progressText:document.querySelector('#training-progress-text').textContent,fill:document.querySelector('#training-progress-fill').style.width,metrics:document.querySelector('#training-metrics').children.length,logLines:(document.querySelector('#training-log').textContent||'').split('\\n').length})")};
   await shot('pages-training.png');
   await wait(()=>evaluate("['completed','failed','stopped'].includes(state.training_info?.status)"),600000,'training finish');
   await pause(4000);
   result.trainingAfter={...await evaluate("({status:document.querySelector('#training-status').textContent,progressText:document.querySelector('#training-progress-text').textContent,fill:document.querySelector('#training-progress-fill').style.width,resultsHidden:document.querySelector('#training-results').hidden,plots:document.querySelectorAll('#training-plots .plot-card').length,firstImageLoaded:(()=>{const i=document.querySelector('#training-plots img');return i?i.naturalWidth:0;})()})")};
   await shot('pages-training-done.png');
  }
 }catch(error){result.errors=[error.stack];try{await shot('pages-failure.png');}catch{}}
 fs.writeFileSync(out,JSON.stringify(result,null,2));
 try{await request('prepare_exit');}catch{}
 setTimeout(()=>{if(backend()?.exitCode===null)backend().kill();app.exit(0);},900);
};
