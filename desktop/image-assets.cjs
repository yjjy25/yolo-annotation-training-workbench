/* Cache immutable image bytes and bound thumbnail work outside the UI event burst. */
function imageDimensions(bytes){
 if(bytes.length>=24&&bytes.toString('hex',0,8)==='89504e470d0a1a0a')return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),mime:'image/png'};
 if(bytes.length>10&&bytes[0]===255&&bytes[1]===216){
  let at=2;
  while(at+8<bytes.length){
   if(bytes[at]!==255){at++;continue;}
   const marker=bytes[at+1];if(marker===255){at++;continue;}
   if(marker===216||marker===217){at+=2;continue;}
   const size=bytes.readUInt16BE(at+2);if(size<2||at+size+2>bytes.length)break;
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return {width:bytes.readUInt16BE(at+7),height:bytes.readUInt16BE(at+5),mime:'image/jpeg'};
   at+=size+2;
  }
 }
 return null;
}
function createImageAssets({fs,nativeImage,maxBytes=64*1024*1024}){
 const cache=new Map(),jobs=[];let busy=false,bytesHeld=0;
 const stats={originalReads:0,thumbnailDecodes:0,cacheHits:0};
 function trim(){while(cache.size>384||bytesHeld>maxBytes){const key=cache.keys().next().value;if(key===undefined)break;bytesHeld-=cache.get(key).bytes;cache.delete(key);}}
 function pump(){
  if(busy||!jobs.length)return;
  jobs.sort((a,b)=>a.priority-b.priority);const job=jobs.shift();busy=true;
  setImmediate(async()=>{try{job.resolve(await job.action());}catch(error){job.reject(error);}finally{busy=false;pump();}});
 }
 function schedule(action,priority){return new Promise((resolve,reject)=>{jobs.push({action,priority,resolve,reject});pump();});}
 async function read(location,width){
  const stamp=await fs.promises.stat(location),thumb=Number.isInteger(width)&&width>=32&&width<=512;
  const key=location+'|'+stamp.mtimeMs+'|'+stamp.size+'|'+(thumb?width:'original');
  if(cache.has(key)){const entry=cache.get(key);cache.delete(key);cache.set(key,entry);stats.cacheHits++;return entry.promise;}
  const entry={bytes:0,promise:null};
  entry.promise=schedule(async()=>{
   let value;
   if(!thumb){
    stats.originalReads++;const bytes=await fs.promises.readFile(location),size=imageDimensions(bytes);
    if(size)value={url:`data:${size.mime};base64,`+bytes.toString('base64'),width:size.width,height:size.height};
    else{const bitmap=nativeImage.createFromBuffer(bytes);if(bitmap.isEmpty())throw new Error('图片无法解码；可用原版工具打开此图片。');value={url:bitmap.toDataURL(),...bitmap.getSize()};}
   }else{
    stats.thumbnailDecodes++;let bitmap;
    if(nativeImage.createThumbnailFromPath){try{bitmap=await nativeImage.createThumbnailFromPath(location,{width,height:width});}catch{}}
    if(!bitmap||bitmap.isEmpty())bitmap=nativeImage.createFromPath(location);
    if(bitmap.isEmpty())throw new Error('图片无法解码；可用原版工具打开此图片。');
    const display=bitmap.resize({width});value={url:display.toDataURL(),...display.getSize()};
   }
   if(cache.get(key)===entry){entry.bytes=value.url.length*2;bytesHeld+=entry.bytes;trim();}
   return value;
  },thumb?1:0).catch(error=>{if(cache.get(key)===entry){bytesHeld-=entry.bytes;cache.delete(key);}throw error;});
  cache.set(key,entry);trim();return entry.promise;
 }
 return {read,stats,clear(){cache.clear();bytesHeld=0;}};
}
module.exports={imageDimensions,createImageAssets};
