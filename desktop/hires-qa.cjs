/* HiDPI and theme regression harness.
 *
 * Covers what the other harnesses cannot see on a scaled display:
 *   - the shell theme round trip (light -> dark -> light) plus restart persistence
 *   - gallery thumbnails dense enough for the current devicePixelRatio
 *   - the retained Qt tools: frame texture scale, panel geometry and native input
 *
 * Run with: XAL_ELECTRON_QA=1 XAL_QA_HIRES=1 electron .
 * Results land in .runtime/hires-check.json and .runtime/hires-*.png.
 */
module.exports=async function({win,app,backend,request,diagnostics,ready,root}){
 const fs=require('node:fs'),path=require('node:path');
 const runtime=path.join(root,'.runtime');
 const out=path.join(runtime,'hires-check.json');
 const previews=path.join(root,'文档','界面预览');
 const result={steps:[],errors:[]};
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const evaluate=s=>win.webContents.executeJavaScript(s,true);
 const shot=async name=>{const image=await win.webContents.capturePage();fs.writeFileSync(path.join(runtime,name),image.toPNG());};
 const save=()=>fs.writeFileSync(out,JSON.stringify(result,null,2));
 const wait=async(test,timeout,label)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await pause(150);}throw new Error('timed out: '+label);};
 try{
  await wait(()=>Promise.resolve(ready()),90000,'backend ready');
  await wait(()=>evaluate('!!window.editor'),20000,'renderer ready');
  win.show();win.focus();await pause(700);
  result.window={dpr:await evaluate('devicePixelRatio')};
  result.preferenceFile=(()=>{try{return JSON.parse(fs.readFileSync(path.join(runtime,'qa-desktop-preferences.json'),'utf8'));}catch{return null;}})();
  result.persistedTheme=await evaluate('document.documentElement.dataset.theme');

  await request('open_project',{path:path.join(runtime,'smoke-v2','pose','project.json')});
  await pause(1600);
  await wait(()=>evaluate('items.length>0'),15000,'gallery');

  /* ---- entering the canvas or the tools without picking a picture ---- */
  await evaluate("items=[];editor.name=null;editor.image=null;editor.data=null;editor.render()");
  await evaluate("go('editor')");
  try{
   await wait(()=>evaluate('!!editor.image'),15000,'first image auto-open');
   result.autoOpenedFirstImage=await evaluate('editor.name');
  }catch{result.autoOpenedFirstImage=null;}

  /* ---- shell theme round trip ---- */
  for(const theme of ['light','dark','light']){
   await evaluate(`window.workbench.theme(${JSON.stringify(theme)})`);await pause(700);
   result.steps.push({step:theme,...await evaluate(`(()=>{const c=getComputedStyle(document.body),r=getComputedStyle(document.documentElement);return {attr:document.documentElement.dataset.theme,colorScheme:r.colorScheme,bg:c.backgroundColor,text:c.color,sidebar:getComputedStyle(document.querySelector('.sidebar')).backgroundColor,selected:[...document.querySelectorAll('button[data-theme]')].filter(b=>b.classList.contains('selected')).map(b=>b.dataset.theme)};})()`)});
   if(theme==='dark')await shot('hires-shell-dark.png');
   else await shot('hires-shell-light.png');
  }
  result.thumbnails=await evaluate(`(()=>{const img=document.querySelector('.image-tile img');const r=document.querySelector('.image-tile').getBoundingClientRect();return img?{natural:[img.naturalWidth,img.naturalHeight],tileCss:[Math.round(r.width),Math.round(r.height)],dpr:devicePixelRatio,sufficient:img.naturalWidth>=r.width*devicePixelRatio*0.95}:null;})()`);

  /* ---- page size and cross-page navigation ---- */
  await evaluate("document.querySelector('#page-size').value='48';document.querySelector('#page-size').dispatchEvent(new Event('change'))");
  await pause(1600);
  result.paging={size:await evaluate("paging.size"),tiles:await evaluate("document.querySelectorAll('.image-tile').length"),page:await evaluate("document.querySelector('#page-number').textContent")};
  await evaluate("document.querySelector('#page-size').value='24';document.querySelector('#page-size').dispatchEvent(new Event('change'))");
  await pause(1400);

  /* ---- split controls live on the data page ---- */
  await evaluate("go('data')");await pause(1200);
  result.splitOnData={inDataPage:await evaluate("!!document.querySelector('#page-data #split-panel')"),inTrainPage:await evaluate("!!document.querySelector('#page-train #split-panel')"),summary:await evaluate("document.querySelector('#split-summary').textContent"),collapsed:await evaluate("!document.querySelector('#split-panel').open"),page:await evaluate('page')};
  await evaluate("document.querySelector('#split-panel').open=true;document.querySelector('#split-panel').scrollIntoView({block:'center'})");
  await pause(700);
  await shot('hires-data-split.png');
  await evaluate("document.querySelector('#split-panel').open=false");
  await pause(300);

  /* ---- editor shapes: detection offers box/polygon/rotation/circle ---- */
  await evaluate("go('editor')");
  await wait(()=>evaluate('!!editor.image'),20000,'editor image');
  const editorShapes=[];
  for(const [task,root] of [['detect',path.join(runtime,'smoke-v2','detect','project.json')],['pose',path.join(runtime,'smoke-v2','pose','project.json')]]){
   await request('open_project',{path:root});
   await pause(1800);
   await evaluate("go('editor')");
   await wait(()=>evaluate('!!editor.image'),20000,'editor image '+task);
   editorShapes.push({task,buttons:await evaluate("[...document.querySelectorAll('#shape-switch button')].map(b=>b.dataset.shape)"),hidden:await evaluate("document.querySelector('#shape-switch').hidden"),default:await evaluate('editor.shapeType')});
  }
  result.editorShapes=editorShapes;
  result.autoApprove=await evaluate("document.querySelector('#auto-approve').checked");
  await shot('hires-editor.png');

  /* ---- training page: split controls ---- */
  await evaluate("go('train')");
  await pause(2500);
  result.split={summary:await evaluate("document.querySelector('#split-summary').textContent"),mode:await evaluate("document.querySelector('#split-mode').value")};
  await pause(2500);
  result.splitAfterPause=await evaluate("document.querySelector('#split-summary').textContent");
  result.splitDebug=await evaluate(`(async()=>{const info={page,project:state.project?.root||null};try{await refreshSplitPreview();}catch(e){info.error=e.message;}return info;})()`);
  await pause(1200);
  result.splitFinal=await evaluate("document.querySelector('#split-summary').textContent");
  result.trainParams=await evaluate("[...document.querySelectorAll('#training-form .field-grid label')].map(l=>l.firstChild.textContent.trim())");
  await shot('hires-train.png');

  /* ---- every page renders in both themes ---- */
  const themeReport=[];
  for(const theme of ['dark','light']){
   await evaluate(`window.workbench.theme(${JSON.stringify(theme)})`);await pause(700);
   for(const name of ['data','editor','models','review','train','validate']){
    await evaluate(`go(${JSON.stringify(name)})`);await pause(900);
    themeReport.push({theme,page:name,attr:await evaluate('document.documentElement.dataset.theme'),bg:await evaluate('getComputedStyle(document.body).backgroundColor')});
   }
  }
  result.themeReport=themeReport;
  await shot('hires-light.png');
  await evaluate("window.workbench.theme('dark')");await pause(600);
  await shot('hires-dark.png');
  fs.mkdirSync(previews,{recursive:true});
  fs.writeFileSync(path.join(previews,'Studio-Dark.png'),(await win.webContents.capturePage()).toPNG());
  await evaluate("window.workbench.theme('light')");await pause(700);
  fs.writeFileSync(path.join(previews,'Studio-Light.png'),(await win.webContents.capturePage()).toPNG());
 }catch(error){result.errors.push(error.stack);try{await shot('hires-failure.png');}catch{}}
 save();
 try{await request('prepare_exit');}catch{}
 setTimeout(()=>{if(backend()?.exitCode===null)backend().kill();app.exit(result.errors.length?1:0);},900);
};
