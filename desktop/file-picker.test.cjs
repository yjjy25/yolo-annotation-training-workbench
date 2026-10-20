const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createFilePicker,collectVideos}=require('./file-picker.cjs');
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-picker-'));
 try{
  const a=path.join(temp,'project-a'),b=path.join(temp,'project-b'),media=path.join(temp,'素材'),nested=path.join(media,'子目录');
  for(const p of [a,b,nested])fs.mkdirSync(p,{recursive:true});
  for(const p of ['2.MP4','1.avi','ignore.txt','子目录/3.mov'])fs.writeFileSync(path.join(media,p),'fixture');
  assert.equal(collectVideos(media).length,3);
  let project={root:a},answer={canceled:false,filePaths:[path.join(media,'2.MP4')]},options,writes=0,prefs={};
  const config={dialog:{showOpenDialog:async(_win,value)=>{options=value;return answer;}},getWindow:()=>null,getProject:()=>project,projects:temp,writePrefs:()=>writes++};
  let choose=createFilePicker({...config,prefs});
  assert.deepEqual(await choose('videos'),answer.filePaths);assert.equal(options.defaultPath,a);assert.ok(options.properties.includes('multiSelections'));
  prefs=JSON.parse(JSON.stringify(prefs));choose=createFilePicker({...config,prefs});
  await choose('video');assert.equal(options.defaultPath,media,'Directory survives preferences reload');
  project={root:b};await choose('videos');assert.equal(options.defaultPath,b,'New project starts from its own root');
  project={root:a};answer={canceled:true,filePaths:[]};const before=writes;assert.equal(await choose('videos'),null);assert.equal(writes,before);
  answer={canceled:false,filePaths:[media]};assert.equal((await choose('video-folder')).length,3);assert.ok(options.properties.includes('openDirectory'));
  answer={canceled:false,filePaths:[path.join(media,'2.MP4')]};await choose('images');assert.equal(options.defaultPath,a,'Image and video memories are independent');
  answer={canceled:false,filePaths:[media]};await choose('source');assert.equal(options.defaultPath,media,'Image files and image folders share source memory');
  prefs.importDirectories[a].video=path.join(temp,'missing');await choose('videos');assert.equal(options.defaultPath,a,'Missing remembered directory falls back to project');
  assert.equal(await choose('invalid'),null);
  console.log('Passed picker multi-selection, recursive video scan, persistent memory, project isolation, cancellation and missing-directory fallback');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
