module.exports=async({win,app,backend,request,ready,root})=>{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
 const folder=process.env.XAL_QA_MODELEXPORT_ROOT,report={checks:[],errors:[],results:[]};fs.mkdirSync(folder,{recursive:true});
 const ev=s=>win.webContents.executeJavaScript(s,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async(fn,ms=120000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(150);}throw Error('Export UI timeout');};
 const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
 const weights=path.join(root,'.runtime','pretrained','yolov8n.pt');
 const digest=()=>crypto.createHash('sha256').update(fs.readFileSync(weights)).digest('hex');const before=digest();
 try{
  await wait(()=>Promise.resolve(ready()));await wait(()=>ev('!!window.videoTracking'));
  const project=path.join(folder,'project'),calibration=path.join(folder,'calibration');fs.mkdirSync(calibration,{recursive:true});
  await request('create_project',{root:project,name:'转换量化验收',task:'detect',classes:['object']});
  // Synthetic calibration images exercise the pipeline only, not accuracy.
  const {nativeImage}=require('electron');
  for(let i=0;i<3;i++){const data=Buffer.alloc(96*64*4);for(let p=0;p<data.length;p+=4){data[p]=(p/4+i*40)%256;data[p+1]=100;data[p+2]=150;data[p+3]=255;}fs.writeFileSync(path.join(calibration,`smoke-${i}.png`),nativeImage.createFromBitmap(data,{width:96,height:64}).toPNG());}
  await ev('api.state().then(update)');await ev("go('export')");
  check('export page visible',await ev("!$('#page-export').hidden&&$('#crumb-page').textContent==='模型转换与量化'"));
  if(process.env.XAL_QA_EXPORTHELP){
   check('long explanations removed from main page',await ev("!$('.export-explanation')&&$('#export-target-info').textContent.includes('ONNX')"));
   await ev(`addOption($('#export-model'),${JSON.stringify(weights)},'本地 YOLOv8n');$('#export-model').value=${JSON.stringify(weights)};refreshExportSource();void 0`);
   await wait(()=>ev("$('#export-source-info').textContent.includes('文件存储精度')"));
   report.modelInfo=await request('model_info',{weights});
   check('source precision read from actual weights',await ev(`$('#export-source-info').textContent.includes(${JSON.stringify(report.modelInfo.precision)})`));
   for(const key of ['exportFormat','exportPrecision']){
    await ev(`$('[data-help="${key}"]').click();void 0`);
    check(`${key} opens existing help dialog`,await ev("$('#help-dialog').open&&$('#help-body').textContent.includes('当前模型')"));
    await pause(250);fs.writeFileSync(path.join(folder,key+'.png'),(await win.webContents.capturePage()).toPNG());
    await ev("$('#help-close').click();void 0");
   }
   await ev("$('#export-precision').value='int8';exportSettings();void 0");
   check('INT8 target and calibration controls agree',await ev("$('#export-target-info').textContent.includes('INT8')&&!$('#export-calibration-fields').hidden"));
   await ev("$('[data-help=exportCalibration]').click();void 0");
   check('calibration dialog explains all four steps',await ev("$('#help-dialog').open&&['第一步','第二步','第三步','第四步','不用画框','前 100 张','不是给图片改颜色','只接收 PT'].every(t=>$('#help-body').textContent.includes(t))"));
   await pause(250);fs.writeFileSync(path.join(folder,'calibration-help.png'),(await win.webContents.capturePage()).toPNG());
   await ev("$('#help-close').click();$('#export-format').value='torchscript';exportSettings();void 0");
   check('TorchScript forces FP32 and hides calibration',await ev("$('#export-target-info').textContent.includes('FP32')&&$('#export-calibration-fields').hidden"));
   await ev("$('#export-format').value='onnx';exportSettings();$('#page-export').scrollIntoView({block:'start'});void 0");
   await pause(250);fs.writeFileSync(path.join(folder,'beginner-help.png'),(await win.webContents.capturePage()).toPNG());
   fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));await request('prepare_exit');app.exit(0);return;
  }
  await ev(`addOption($('#export-model'),${JSON.stringify(weights)},'YOLOv8n 本地权重');$('#export-model').value=${JSON.stringify(weights)};$('#export-imgsz').value='64';$('#export-calibration').value=${JSON.stringify(calibration)};void 0`);
  for(const [format,precision] of [['onnx','fp32'],['onnx','int8'],['onnx','fp16'],['torchscript','fp32']]){
   await ev(`$('#export-format').value=${JSON.stringify(format)};$('#export-precision').value=${JSON.stringify(precision)};exportSettings();$('#export-form').requestSubmit();void 0`);
   await wait(()=>ev("['starting','running'].includes(state.export_info?.status)"));
   const blocked=await request('open_project',{path:path.join(project,'project.json')}).then(()=>false,error=>error.message.includes('转换'));
   check(`${format}/${precision} prevents project switching`,blocked);
   await wait(()=>ev("['completed','failed'].includes(state.export_info?.status)"),240000);
   const info=await ev('state.export_info');report.results.push(info);
   check(`${format}/${precision} creates a usable artifact`,info.status==='completed'&&fs.existsSync(info.output));
   const record=JSON.parse(fs.readFileSync(path.join(info.run,'export.json'),'utf8'));
   check(`${format}/${precision} saves provenance`,record.source_sha256===before&&record.sha256&&record.status==='completed');
   if(precision==='int8')check('INT8 used three calibration images',record.calibration.length===3);
   await pause(250);fs.writeFileSync(path.join(folder,`${format}-${precision}.png`),(await win.webContents.capturePage()).toPNG());
  }
  check('source weights unchanged',digest()===before);
  await ev("$('#export-format').value='torchscript';$('#export-precision').value='int8';exportSettings();void 0");
  check('TorchScript forces supported precision',await ev("$('#export-precision').value==='fp32'&&$('#export-calibration-fields').hidden"));
  let failure='';try{await request('start_export',{weights,format:'onnx',precision:'int8',imgsz:64});}catch(error){failure=error.message;}
  check('INT8 without calibration rejected',failure.includes('校准'));
  await request('start_export',{weights,format:'onnx',precision:'fp32',imgsz:64});
  await request('stop_export');await wait(()=>ev("state.export_info?.status==='stopped'"));
  check('active conversion can be stopped',await ev("state.export_info.status==='stopped'&&$('#export-stop').disabled"));
  await pause(250);
  await ev("$('#export-status').scrollIntoView({block:'center'});void 0");
  fs.writeFileSync(path.join(folder,'model-export.png'),(await win.webContents.capturePage()).toPNG());
 }catch(error){report.errors.push(error.stack);try{fs.writeFileSync(path.join(folder,'failure.png'),(await win.webContents.capturePage()).toPNG());}catch{}}
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));try{await request('prepare_exit');}catch{}if(backend()?.exitCode===null)backend().kill();app.exit(report.errors.length?1:0);
};
