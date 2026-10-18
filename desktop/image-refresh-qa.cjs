/* Measure actual decoded pixels and retained thumbnail nodes on a copied real-size clip. */
module.exports=async({win,app,backend,request,ready})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const folder=process.env.XAL_QA_IMAGEPIPELINE_ROOT,before=process.env.XAL_QA_IMAGEPIPELINE_BASELINE==='1';
 const report={baseline:before,checks:[],cycles:[],errors:[]};
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async fn=>{const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await pause(30);}throw new Error('UI timeout');};
 let lastBeat=Date.now(),maxGap=0;const beat=setInterval(()=>{const now=Date.now();maxGap=Math.max(maxGap,now-lastBeat);lastBeat=now;},16);
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.videoTracking'));win.show();win.focus();
  await request('open_project',{path:path.join(folder,'project','project.json')});await ev('api.state().then(update)');await ev('window.videoTracking.refresh()');await ev("go('video-review')");
  const names=(await request('video_sequences'))[0].review_frames;
  await ev("$('#review-gallery .review-open').click();void 0");await wait(()=>ev(`editor.name===${JSON.stringify(names[0])}&&!editor.opening`));
  await wait(()=>ev("[...$('#filmstrip').querySelectorAll('img')].every(i=>i.complete&&i.naturalWidth)"));
  report.resolution=await ev('({width:editor.image.naturalWidth,height:editor.image.naturalHeight})');
  await ev("window.__photoBlank=0;window.__stripBlank=0;window.__sampleOn=true;window.__sample=()=>{if(!window.__sampleOn)return;const imgs=[...$('#filmstrip').querySelectorAll('img')];if(imgs.length&&imgs.every(i=>!i.naturalWidth||!i.complete))window.__stripBlank++;const p=[.35,.5,.65].map(f=>{const x=Math.floor((editor.offset[0]+editor.image.naturalWidth*editor.zoom*f)*devicePixelRatio),y=Math.floor((editor.offset[1]+editor.image.naturalHeight*editor.zoom*.5)*devicePixelRatio);return editor.ctx.getImageData(x,y,1,1).data;});if(p.every(v=>v[0]+v[1]+v[2]<12))window.__photoBlank++;requestAnimationFrame(window.__sample)};requestAnimationFrame(window.__sample);void 0");
  for(let i=0;i<5;i++){
   await ev("window.__nodes=[...$('#filmstrip').children];window.__photoBlank=0;window.__stripBlank=0;void 0");
   const start=Date.now();win.webContents.sendInputEvent({type:'keyDown',keyCode:'S'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'S'});
   await wait(()=>ev(`editor.name===${JSON.stringify(names[i+1])}&&!editor.approving&&!editor.confirming`));
   const result=await ev("({photoBlank:window.__photoBlank,stripBlank:window.__stripBlank,oldNodes:window.__nodes.length,retained:window.__nodes.filter(n=>n.isConnected).length})");
   result.elapsedMs=Date.now()-start;report.cycles.push(result);
   await pause(200);
  }
  await ev('window.__sampleOn=false;void 0');
  report.mainThreadMaxGapMs=maxGap;report.medianSaveNextMs=report.cycles.map(c=>c.elapsedMs).sort((a,b)=>a-b)[2];
  if(!before){
   assert.ok(report.cycles.every(c=>c.photoBlank===0),'decoded canvas pixels must stay painted');report.checks.push('Canvas image pixels remain visible across real-size saves');
   assert.ok(report.cycles.every(c=>c.stripBlank===0),'filmstrip must never clear all thumbnails');report.checks.push('Filmstrip keeps decoded thumbnails throughout save and next');
   assert.ok(report.cycles.every(c=>c.retained>=c.oldNodes-3),'unchanged filmstrip DOM nodes must be retained');report.checks.push('Save updates only the removed and newly visible thumbnail entries');
   report.checks.push('Five consecutive saves audit and advance without manual switching');
  }
  fs.writeFileSync(path.join(folder,'after-save.png'),(await win.webContents.capturePage()).toPNG());
 }catch(error){report.errors.push(error.stack);try{fs.writeFileSync(path.join(folder,'failure.png'),(await win.webContents.capturePage()).toPNG());}catch{}}
 clearInterval(beat);fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
