const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const nodes=new Map(),node=s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const context={window:{workbench:{asset:async name=>({url:name})}},document:{addEventListener(){},querySelector:node},structuredClone,Promise,
 Image:class{async decode(){await pause(5);if(this.src==='bad')throw new Error('decode failure');}},confirm:()=>true};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'editor.js'),'utf8'),context);
const proto=context.window.AnnotationEditor.prototype;
function make(){
 const e=Object.create(proto),calls=[];
 Object.assign(e,{name:'old',project:{root:'project',task:'detect',classes:['object']},data:{shapes:[{points:[[1,1],[4,4]]}],checked:false},
  image:{id:'old-image'},dirty:false,baseHash:'old-hash',loadToken:0,pending:[],history:[],future:[],selectedMany:[],
  status(){},setMode(){},fit(){},list(){},hint(){},candidate(){},
  callbacks:{toast(){},onSave(){},navigate:async()=>{},rpc:async(method,args)=>{calls.push({method,...structuredClone(args)});await pause(15);if(method==='save_annotation')return {base_hash:'saved-hash',checked:args.checked};if(args.name==='missing')throw new Error('temporary load failure');return {base_hash:args.name+'-hash',annotation:{shapes:[],flags:{}}};}}});
 return {e,calls};
}
(async()=>{
 let {e,calls}=make();e.dirty=true;
 await Promise.all(Array.from({length:60},()=>e.confirmSave()));
 assert.equal(calls.filter(c=>c.method==='save_annotation').length,1);assert.equal(e.data.checked,true);
 await e.confirmSave();assert.equal(calls.length,1,'unchanged audited image must not be written again');
 console.log('PASS repeated save commands share one complete write');
 ({e,calls}=make());e.dirty=true;const save=e.save(true);await pause(2);e.data.shapes[0].points[0][0]=8;e.dirty=true;await save;
 assert.equal(e.dirty,true);assert.notEqual(e.data.checked,true);assert.equal(e.baseHash,'saved-hash');
 console.log('PASS edits during save remain dirty with the correct new base hash');
 ({e,calls}=make());e.dirty=true;const old=e.save();await pause(2);e.name='new';e.data={shapes:[]};e.project={root:'other'};e.baseHash='other-hash';await old;assert.equal(e.baseHash,'other-hash');
 console.log('PASS late save response never overwrites another document hash');
 ({e,calls}=make());const original=e.image;const requests=[];
 for(let i=0;i<40;i++)requests.push(e.open('image-'+i));
 assert.equal(e.image,original,'existing pixels remain visible while loading');await Promise.all(requests);
 assert.equal(e.name,'image-39');assert.equal(calls.filter(c=>c.method==='load_annotation').length,1);
 console.log('PASS rapid image requests load only the last requested target');
 ({e,calls}=make());const first=e.open('first');await pause(2);const second=e.open('last');await Promise.all([first,second]);assert.equal(e.name,'last');
 assert.equal(calls.filter(c=>c.method==='load_annotation').length,2);
 console.log('PASS a superseded in-flight load cannot commit stale content');
 ({e,calls}=make());const pixels=e.image;await assert.rejects(e.open('missing'),/temporary load failure/);assert.equal(e.name,'old');assert.equal(e.image,pixels);
 await assert.rejects(e.open('bad'),/decode failure/);assert.equal(e.image,pixels);assert.equal(e.baseHash,'old-hash');
 console.log('PASS load and decode failures preserve the current usable canvas');
 ({e,calls}=make());let moves=0;e.dirty=true;e.callbacks.navigate=async()=>{moves++;await e.open('next');};
 await Promise.all(Array.from({length:40},()=>e.approve()));assert.equal(moves,1);assert.equal(e.name,'next');
 console.log('PASS repeated approve commands save once and navigate once without deadlock');
 ({e,calls}=make());e.dirty=true;const confirmation=e.confirmSave(),opening=e.open('next');await Promise.all([confirmation,opening]);
 assert.equal(calls[0].method,'save_annotation');assert.equal(calls[0].name,'old');assert.equal(e.name,'next');
 console.log('PASS navigation waits for confirmation of the original image');
 ({e,calls}=make());e.pending=[[1,1],[2,2]];e.closePendingContour=()=>false;
 await assert.rejects(e.open('next'),/当前轮廓/);assert.equal(e.name,'old');assert.equal(e.pending.length,2);assert.equal(calls.length,0);
 console.log('PASS unfinished contours remain visible instead of being discarded on navigation');
 ({e,calls}=make());e.dirty=true;let prepared=0,advanced=0;
 e.callbacks.prepareNext=()=>{prepared++;const source=e.name;return async()=>{advanced++;assert.equal(source,'old');await e.open('chosen-successor');};};
 e.callbacks.navigate=()=>{throw new Error('must use the captured successor');};
 await Promise.all(Array.from({length:25},()=>e.approve()));
 assert.equal(prepared,1);assert.equal(advanced,1);assert.equal(e.name,'chosen-successor');
 console.log('PASS Save captures its successor once before confirmation and advances outside the save lock');
})().catch(error=>{console.error(error);process.exitCode=1;});
