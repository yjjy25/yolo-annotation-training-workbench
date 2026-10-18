/* Native clicks verify numbered keypoints are actually painted on photographs. */
module.exports=async({win,app,backend,request,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const folder=process.env.XAL_QA_POSEPHOTO_ROOT,report={checks:[],errors:[]};
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async fn=>{const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await pause(70);}throw new Error('UI timeout');};
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
 const click=async selector=>{const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await pause(100);};
 const key=async keyCode=>{for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode});await pause(100);};
 const screenshot=async name=>{await ev("document.querySelector('#pose-guide-dialog').scrollTop=0");await pause(350);fs.writeFileSync(path.join(folder,name),(await win.webContents.capturePage()).toPNG());};
 const selected=()=>wait(()=>ev("document.querySelector('#pose-photo').dataset.ready==='true'"));
 const source=path.join(root,'.runtime','video-pose-qa-accepted-20261018','project','images');
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.showVideoImport'));win.show();win.focus();
  await request('create_project',{root:path.join(folder,'dog'),name:'狗照片点位验收',task:'pose',classes:['dog'],preset:'dog',source});
  await ev('api.state().then(update)');await ev("go('editor')");await click('#pose-guide-open');await selected();
  check('two full-body dog reference photos available',await ev("document.querySelector('#pose-photo-select').options.length===2"));
  check('24 actual coordinates rendered on photograph',await ev("document.querySelector('#pose-photo').dataset.pointCount==='24'"));
  await click('#pose-point-legend button:nth-child(3)');await selected();
  check('left front elbow highlights on photograph',await ev("document.querySelector('#pose-photo').dataset.highlightPresent==='true'&&document.querySelector('#pose-photo-point-status').textContent.includes('左前肘')"));
  // Read pixels at the ORIGINAL dataset coordinate transformed into canvas space.
  check('pink marker is at the real elbow coordinate rather than template position',await ev(`(()=>{const c=document.querySelector('#pose-photo'),s=520/640,p=[561.3*s,15+308*s],pixels=c.getContext('2d').getImageData(Math.round(p[0])-3,Math.round(p[1])-3,7,7).data;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>240&&pixels[i+1]>110&&pixels[i+1]<170&&pixels[i+2]>130&&pixels[i+2]<180)return true;return false;})()`));
  await screenshot('dog-elbow-photo.png');
  for(let i=1;i<=24;i++){
   await click(`#pose-point-legend button:nth-child(${i})`);await selected();
   check('dog point '+i+' has corresponding photograph location',await ev("document.querySelector('#pose-photo').dataset.highlightPresent==='true'"));
  }
  check('supplemental teaching points clearly identified',await ev("document.querySelector('#pose-photo-point-status').textContent.includes('人工教学定位')&&document.querySelector('#pose-photo-note').textContent.includes('21–24')"));
  await ev("document.querySelector('#pose-photo-select').focus()");await key('Down');await key('Return');await selected();
  check('switching photograph retains selected point and redraws coordinates',await ev("document.querySelector('#pose-photo-select').value==='1'&&document.querySelector('#pose-photo').dataset.highlightPresent==='true'"));
  await screenshot('dog-second-photo.png');
  // A native click on the new photograph's point 3 must select the matching name.
  const hit=await ev(`(async()=>{const example=(await api.poseReference({builtin:true})).examples[1],shape=example.annotation.shapes.find(s=>s.label==='front_left_elbow'),w=example.annotation.imageWidth,h=example.annotation.imageHeight,scale=Math.min(520/w,420/h),x=(520-w*scale)/2+shape.points[0][0]*scale,y=(420-h*scale)/2+shape.points[0][1]*scale;const c=document.querySelector('#pose-photo');c.scrollIntoView({block:'nearest'});const r=c.getBoundingClientRect();return {x:Math.round(r.x+x*r.width/520),y:Math.round(r.y+y*r.height/420)};})()`);
  for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...hit});await pause(150);await selected();
  check('clicking photograph point selects the same numbered landmark',await ev("document.querySelector('#pose-point-legend button:nth-child(3)').classList.contains('selected')"));
  await click('#pose-guide-close');
  await request('create_project',{root:path.join(folder,'human'),name:'人体照片点位验收',task:'pose',classes:['person'],preset:'human',source});
  await ev('api.state().then(update)');await ev("go('editor')");await click('#pose-guide-open');await selected();await click('#pose-point-legend button:nth-child(8)');await selected();
  check('human photograph keeps actual annotated elbow coordinates',await ev("document.querySelector('#pose-photo').dataset.highlightPresent==='true'&&document.querySelector('#pose-photo-point-status').textContent.includes('左肘')"));
  await screenshot('human-photo.png');await click('#pose-guide-close');
  await request('create_project',{root:path.join(folder,'custom'),name:'自定义缺失点验收',task:'pose',classes:['object'],preset:'custom',template:{points:['base','tip'],edges:[[0,1]],pairs:[]},source});
  await ev('api.state().then(update)');await ev("go('editor')");await wait(()=>ev('!!editor.name'));
  const name=await ev('editor.name');
  await request('save_annotation',{name,base_hash:null,checked:false,annotation:{shapes:[{label:'object',shape_type:'rectangle',group_id:1,points:[[10,10],[140,10],[140,110],[10,110]],flags:{},difficult:false},{label:'base',shape_type:'point',group_id:1,points:[[50,50]],flags:{},difficult:false}],flags:{}}});
  await ev('editor.open(editor.name)');await click('#pose-guide-open');await selected();await click('#pose-example-set');await selected();await click('#pose-point-legend button:nth-child(2)');await selected();
  check('missing photograph keypoint explicitly reported without guessing',await ev("document.querySelector('#pose-photo').dataset.highlightPresent==='false'&&document.querySelector('#pose-photo-point-status').textContent.includes('没有该点坐标')"));
  await screenshot('missing-point.png');await click('#pose-guide-close');
  check('no horizontal overflow',await ev('document.documentElement.scrollWidth<=innerWidth'));
 }catch(error){report.errors.push(error.stack);try{await screenshot('failure.png');}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
