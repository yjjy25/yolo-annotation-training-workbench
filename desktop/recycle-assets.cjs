/* Only read regular image files inside the active project's recycle directories. */
const fs=require('node:fs'),path=require('node:path');
function recycleImage(root,relative){
 if(typeof relative!=='string')throw new Error('回收站图片路径无效。');
 const parts=relative.replaceAll('\\','/').split('/');
 if(parts.some(p=>!p||p==='.'||p==='..'||p.includes(':'))||!(parts[0]==='removed'||parts[0]==='video-work'&&parts[1]==='removed'))throw new Error('只能预览当前项目回收站中的图片。');
 if(!/\.(png|jpe?g|bmp|webp|tiff?)$/i.test(relative))throw new Error('图片格式不支持。');
 let target=path.resolve(root);
 for(const part of parts){target=path.join(target,part);if(fs.lstatSync(target).isSymbolicLink()||fs.realpathSync(target)!==target)throw new Error('不支持预览链接文件。');}
 if(!fs.statSync(target).isFile())throw new Error('回收站图片不存在。');
 return target;
}
module.exports={recycleImage};
