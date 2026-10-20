const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {recycleImage}=require('./recycle-assets.cjs');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'recycle-preview-'));
try{
 for(const relative of ['removed/images/a.png','video-work/removed/frames_1/images/b.jpg']){const file=path.join(folder,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');assert.equal(recycleImage(folder,relative),file);}
 for(const relative of ['../outside.png','removed/../../outside.png','images/current.png','removed/images/../a.png','removed/images/a.json','C:/outside.png','/removed/images/a.png',null])assert.throws(()=>recycleImage(folder,relative));
 const external=path.join(folder,'outside.png');fs.writeFileSync(external,'outside');
 let linkCreated=false;try{fs.symlinkSync(folder,path.join(folder,'removed','linked'),'junction');linkCreated=true;}catch{}
 if(linkCreated)assert.throws(()=>recycleImage(folder,'removed/linked/outside.png'));
 console.log('Passed recycle preview paths, nested video archives, invalid formats, traversal and link refusal.');
}finally{fs.rmSync(folder,{recursive:true,force:true});}
