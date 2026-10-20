module.exports=async({win,app,backend,request,ready})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const folder=process.env.XAL_QA_DATASETBULK_ROOT,report={checks:[],errors:[]};
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);};
 const wait=async fn=>{const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await pause(100);}throw new Error('UI timeout');};
 const shot=async name=>{await pause(250);fs.writeFileSync(path.join(folder,name),(await win.webContents.capturePage()).toPNG());};
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.datasetTools'));win.show();
  const root=path.join(folder,'项目'),source=path.join(folder,'来源');
  await request('create_project',{root,name:'批量移除与标注记号',task:'detect',classes:['object'],source});await ev('api.state().then(update)');await ev('loadImages()');
  const names=fs.readdirSync(path.join(root,'images')).sort();
  for(const [i,checked] of [[0,false],[1,true]]){
   const loaded=await request('load_annotation',{name:names[i]});
   const annotation={shapes:[{label:'object',shape_type:'rectangle',points:[[20,20],[90,20],[90,80],[20,80]],flags:{},group_id:null}],flags:{},imageWidth:160,imageHeight:120};
   await request('save_annotation',{name:names[i],annotation,base_hash:loaded.base_hash,checked});
  }
  await ev('api.state().then(update)');await ev('loadImages()');await ev(`openImage(${JSON.stringify(names[0])})`);
  check('saved annotation shows a visible annotated badge',await ev(`$('#filmstrip').querySelector('[data-name="${names[0]}"] .film-status').textContent==='● 已标注'`));
  check('reviewed image has a distinct reviewed badge',await ev(`$('#filmstrip').querySelector('[data-name="${names[1]}"] .film-status').textContent==='✓ 已审核'`));
  check('untouched image is visibly unannotated',await ev(`$('#filmstrip').querySelector('[data-name="${names[2]}"] .film-status').textContent==='○ 未标注'`));
  await ev('editor.confirmSave()');await wait(()=>ev("!editor.confirming"));
  await wait(()=>ev(`$('#filmstrip').querySelector('[data-name="${names[0]}"] .film-status')?.textContent==='✓ 已审核'`));
  check('save-and-next updates reviewed badge without restart',await ev(`$('#filmstrip').querySelector('[data-name="${names[0]}"] .film-status').textContent==='✓ 已审核'`));await shot('canvas-markers.png');
  await ev("go('data')");
  await ev("$('#gallery .tile-select').click()");check('checkbox selects without navigating to canvas',await ev("page==='data'&&$('#dataset-selected-count').textContent==='已选 1 张'"));
  await ev("$('#next-page').click()");await wait(()=>ev('paging.page===1'));await ev("$('#gallery .tile-select').click()");
  check('selection survives pagination',await ev("$('#dataset-selected-count').textContent==='已选 2 张'"));await shot('selection-page-two.png');
  await ev("$('#dataset-remove-selected').click();void 0");await wait(()=>ev("$('#dataset-remove-dialog').open"));
  check('batch removal confirms exact selection count',await ev("$('#dataset-remove-question').textContent.includes('2 张')"));
  await ev("$('#dataset-remove-dialog').close('cancel')");await pause(150);check('cancel leaves all dataset images intact',fs.readdirSync(path.join(root,'images')).length===28);
  await ev("$('#dataset-remove-selected').click();void 0");await wait(()=>ev("$('#dataset-remove-dialog').open"));await ev("$('#dataset-remove-confirm').click()");
  await wait(()=>ev('state.project.counts.total===26&&!$("#page-data").inert'));
  check('batch removal archives both selected images',fs.readdirSync(path.join(root,'removed','images')).length===2);
  check('removed annotations remain recoverable',fs.existsSync(path.join(root,'removed','annotations',path.parse(names[0]).name+'.json')));
  check('gallery refreshes and clears successful selections',await ev("$('#dataset-selected-count').textContent==='已选 0 张'&&$('#gallery').querySelectorAll('.tile-select:checked').length===0"));
  await ev("$('#dataset-select-page').click()");check('select-page checks all visible images',await ev("items.every(i=>$('#gallery').querySelector('[data-name=\"'+i.name+'\"] .tile-select').checked)"));
  await ev("$('#dataset-clear-selection').click()");
  await ev(`$('#image-search').value=${JSON.stringify(names[1])};paging.page=0;loadImages()`);await wait(()=>ev('paging.total===1'));
  await ev("$('#dataset-remove-all').click();void 0");await wait(()=>ev("$('#dataset-remove-dialog').open"));
  check('remove-all explicitly includes images hidden by filters',await ev("$('#dataset-remove-question').textContent.includes('全部 26 张')&&$('#dataset-remove-question').textContent.includes('未显示')"));await shot('remove-all-confirmation.png');
  await ev("$('#dataset-remove-confirm').click()");await wait(()=>ev('state.project.counts.total===0&&!$("#page-data").inert'));
  check('remove-all clears the whole dataset across pages and filters',fs.readdirSync(path.join(root,'images')).length===0&&fs.readdirSync(path.join(root,'removed','images')).length===28);
  check('original source and project configuration remain',fs.readdirSync(source).length===28&&fs.existsSync(path.join(root,'project.json')));
  check('removed current canvas image is released',await ev('editor.name===null||!editor.name'));
  await request('create_project',{root:path.join(folder,'新项目'),name:'选择隔离',task:'detect',classes:['object'],source});await ev('api.state().then(update)');await ev('loadImages()');await ev("$('#gallery .tile-select').click()");
  await request('open_project',{path:path.join(root,'project.json')});await ev('api.state().then(update)');await ev('loadImages()');
  check('selection never leaks across projects',await ev("$('#dataset-selected-count').textContent==='已选 0 张'"));
 }catch(error){report.errors.push(error.stack);try{await shot('failure.png');}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
 try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
