module.exports=async({win,app,backend,request,ready,dialog,chooseFile})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const folder=process.env.XAL_QA_VIDEOIMPORT_ROOT,report={checks:[],errors:[]};
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);};
 const wait=async fn=>{const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await pause(120);}throw new Error('UI timeout');};
 const shot=async name=>{await pause(200);fs.writeFileSync(path.join(folder,name),(await win.webContents.capturePage()).toPNG());};
 const select=async kind=>ev(`$('#import-data-kind').value=${JSON.stringify(kind)};$('#import-data-kind').dispatchEvent(new Event('change'));void 0`);
 let answer,options;const original=dialog.showOpenDialog;
 dialog.showOpenDialog=async(_win,value)=>{options=value;return answer;};
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.setTrackingVideos'));win.show();
  const root=path.join(folder,'项目'),media=path.join(folder,'素材');
  await request('create_project',{root,name:'批量视频导入验收',task:'detect',classes:['object']});await ev('api.state().then(update)');
  answer={canceled:false,filePaths:[media]};const files=await chooseFile('video-folder');
  check('first picker opens current project',options.defaultPath===root);check('folder scan imports supported videos from nested folders',files.length===2);
  answer={canceled:true,filePaths:[]};await chooseFile('videos');check('video picker remembers folder across picker kinds',options.defaultPath===media);check('video file picker supports multiple selection',options.properties.includes('multiSelections'));
  await chooseFile('images');check('image import initially opens project directory',options.defaultPath===root);
  await ev(`$('#import-data').click()`);await select('frames');answer={canceled:false,filePaths:[media]};await ev(`$('#import-data-choose-all').onclick()`);
  check('data dialog shows video batch count',await ev("$('#import-data-path').value.startsWith('已选择 2 个视频')"));await ev("$('#import-data-form').requestSubmit();void 0");
  await wait(()=>ev("$('#video-dialog').open"));await ev("$('#video-step').value='0.2';$('#video-limit').value='5';$('#video-form').requestSubmit();void 0");
  await wait(()=>ev("!$('#video-dialog').open&&state.project.counts.total===10"));
  check('two real videos extract 5 frames each through the data import UI',true);
  await ev("go('editor')");await wait(()=>ev('!!editor.image'));
  check('annotation canvas hides video timeline',await ev("$('#video-timeline').hidden&&getComputedStyle($('#video-timeline')).display==='none'"));await shot('canvas-without-timeline.png');
  const current=await ev('editor.name');await ev('navigate(1)');check('hidden timeline preserves video frame navigation',await ev(`editor.name!==${JSON.stringify(current)}`));
  await ev("go('data')");await ev("$('#import-data').click()");await select('tracking');answer={canceled:false,filePaths:files};await ev("$('#import-data-choose').onclick()");await ev("$('#import-data-form').requestSubmit();void 0");
  await wait(()=>ev("page==='video'&&$('#tracking-path').value.startsWith('已选择 2 个视频')"));
  await ev("$('#tracking-form').requestSubmit();void 0");await wait(()=>ev("$('#tracking-create-status').textContent.startsWith('已导入 2/2')"));
  check('batch tracking creates two independent sessions',await ev("$('#tracking-sessions').querySelectorAll('.tracking-session').length===2"));
  check('video route retains original-frame timeline',await ev("page==='video'&&!$('#video-timeline').hidden&&getComputedStyle($('#video-timeline')).display!=='none'"));
  check('tracking import leaves confirmed dataset unchanged',await ev('state.project.counts.total===10'));await shot('batch-tracking.png');
  await ev("$('#tracking-library').open=true");await shot('batch-video-list.png');
  // A bad file must not discard the successful remainder of the batch.
  await ev(`window.setTrackingVideos(${JSON.stringify([path.join(folder,'broken.mp4'),files[0]])});$('#tracking-form').requestSubmit();void 0`);
  await wait(()=>ev("$('#tracking-create-status').textContent.startsWith('已导入 1/2')"));
  check('tracking batch continues after one unreadable video',await ev("$('#tracking-create-status').textContent.includes('broken.mp4')&&$('#tracking-sessions').querySelectorAll('.tracking-session').length===3"));
  // Slow status observation so cancellation reliably occurs while a job is active.
  await ev("go('data')");await ev(`window.showVideoImport(${JSON.stringify([files[0],path.join(folder,'broken.mp4'),files[1]])});$('#video-limit').value='1';$('#video-form').requestSubmit();void 0`);
  await wait(()=>ev("!$('#video-submit').disabled&&$('#video-status').textContent.includes('失败：')"));
  check('frame batch continues after bad video and reports exact successes',await ev("$('#video-status').textContent.includes('已导入 2/3 个视频，共 2 帧')&&state.project.counts.total===12"));
  await ev("$('#video-dialog').close()");
  await ev(`window.showVideoImport(${JSON.stringify(files)});window.__oldRPC=rpc;rpc=async(m,a)=>{if(m==='video_status')await new Promise(r=>setTimeout(r,500));return window.__oldRPC(m,a);};$('#video-form').requestSubmit();void 0`);
  await ev("$('#video-cancel').onclick()");await wait(()=>ev("!$('#video-submit').disabled"));
  check('cancel stops remaining videos and keeps previous imports',await ev("$('#video-status').textContent.startsWith('已取消后续导入。')&&state.project.counts.total<=13&&state.project.counts.total>=12"));
  await ev('rpc=window.__oldRPC;void 0');
  await ev("$('#video-dialog').close()");
  const batchFolder=path.join(folder,'连续13个视频');fs.mkdirSync(batchFolder,{recursive:true});
  const batch=Array.from({length:13},(_,i)=>{const target=path.join(batchFolder,`clip-${String(i+1).padStart(2,'0')}.avi`);fs.copyFileSync(files[0],target);return target;});
  const beforeBatch=await ev('state.project.counts.total');
  await ev(`window.showVideoImport(${JSON.stringify(batch)});$('#video-limit').value='500';$('#video-step').value='0.2';$('#video-form').requestSubmit();void 0`);
  await wait(()=>ev("!$('#video-submit').disabled"));
  check('13 consecutive video imports release each process before starting the next',await ev("$('#video-status').textContent.startsWith('已导入 13/13 个视频，共 130 帧。')&&!$('#video-status').textContent.includes('失败')"));
  check('all 130 batch frames are retained alongside earlier imports',await ev(`state.project.counts.total===${beforeBatch+130}`));

 }catch(error){report.errors.push(error.stack);try{await shot('failure.png');}catch{}}
 finally{dialog.showOpenDialog=original;}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
