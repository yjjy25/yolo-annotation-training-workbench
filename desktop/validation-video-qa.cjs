module.exports=async({win,app,backend,request,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const folder=process.env.XAL_QA_VALIDATIONVIDEO_ROOT,report={checks:[],errors:[]};
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async fn=>{const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await pause(40);}throw Error('UI timeout');};
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.videoTracking'));win.show();win.focus();
  await request('open_project',{path:path.join(folder,'project','project.json')});await ev('api.state().then(update)');await ev("go('validate')");
  await request('start_validation',{weights:path.join(root,'.runtime','pretrained','yolov8n.pt'),source:'video',custom_path:path.join(folder,'demo.avi'),device:'cpu',imgsz:320,video_step:.5,plots:true});
  await wait(()=>ev("state.validationInfo?.status==='completed'"));
  check('video validation worker completes and publishes its results',true);
  await ev('refreshValidationPlots()');
  await wait(()=>ev("!$('#validation-video-wrap').hidden&&$('#validation-video').readyState>=2"));
  report.video=await ev("({width:$('#validation-video').videoWidth,height:$('#validation-video').videoHeight,duration:$('#validation-video').duration,controls:$('#validation-video').controls})");
  check('real model output decodes in the embedded player',report.video.width===320&&report.video.height===432&&report.video.controls);
  check('full video duration is retained',Math.abs(report.video.duration-1.2)<.15);
  await ev("$('#validation-video').currentTime=.6;void 0");await wait(()=>ev("!$('#validation-video').seeking&&$('#validation-video').currentTime>=.59"));
  check('progress seeking works',true);await ev("$('#validation-video').play()");await wait(()=>ev("$('#validation-video').currentTime>.75"));await ev("$('#validation-video').pause();void 0");
  check('playback advances and pauses',await ev("$('#validation-video').paused"));
  await ev("$('#validation-video-wrap').scrollIntoView({block:'center'});void 0");await pause(250);fs.writeFileSync(path.join(folder,'player.png'),(await win.webContents.capturePage()).toPNG());
  await ev("showValidationPlots({id:'old-photo-record',plots:[]})");check('photo-only history clears the previous video',await ev("$('#validation-video-wrap').hidden&&!$('#validation-video').getAttribute('src')"));
  await ev('refreshValidationPlots()');await wait(()=>ev("$('#validation-video').readyState>=2"));
  await ev("go('data')");check('leaving validation pauses the player',await ev("$('#validation-video').paused"));
  const rejected=await ev("api.resultVideo('../demo.avi').then(()=>false,()=>true)");check('video endpoint rejects paths outside validation results',rejected);
 }catch(error){report.errors.push(error.stack);try{fs.writeFileSync(path.join(folder,'failure.png'),(await win.webContents.capturePage()).toPNG());}catch{}}
 fs.writeFileSync(path.join(folder,'player-report.json'),JSON.stringify(report,null,2));try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
