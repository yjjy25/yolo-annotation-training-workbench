const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const nodes=new Map();
const node=id=>{if(!nodes.has(id))nodes.set(id,{checked:false,textContent:'',disabled:false,hidden:false});return nodes.get(id);};
const context={window:{},document:{addEventListener(){},querySelector:s=>s==='dialog[open]'?null:node(s)},structuredClone};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'editor.js'),'utf8'),context);
const proto=context.window.AnnotationEditor.prototype;
function editor(){
 const e=Object.create(proto);
 Object.assign(e,{project:{task:'pose',classes:['person'],template:{points:['left','right','nose'],positions:[[.2,.4],[.8,.4],[.5,.2]]}},
  data:{shapes:[{label:'person',shape_type:'rectangle',group_id:1,points:[[10,10],[90,10],[90,90],[10,90]]}],flags:{}},
  image:{naturalWidth:100,naturalHeight:100},pose:{group:1,index:0},selected:-1,selectedMany:[],nextOccluded:false,history:[],future:[],pending:[],mode:'draw',zoom:1,offset:[0,0],
  canvas:{focus(){},style:{},getBoundingClientRect(){return {left:0,top:0};},setPointerCapture(){},hasPointerCapture(){return false;}},
  callbacks:{toast(){},isEditor:()=>true},render(){},list(){},status(){},hint(){},changed(){this.dirty=true;},setMode(mode){this.mode=mode;this.pose=null;}});
 return e;
}
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('next point occlusion is separate and resets after placement',()=>{const e=editor();e.setOccluded(true);e.placePoint([25,30]);assert.equal(e.data.shapes[1].difficult,true);assert.equal(e.selected,-1);assert.equal(e.nextOccluded,false);e.placePoint([75,30]);assert.equal(e.data.shapes[2].difficult,false);});
test('selected existing point occlusion does not affect next point',()=>{const e=editor();e.placePoint([25,30]);e.selected=1;e.setOccluded(true);e.placePoint([75,30]);assert.equal(e.data.shapes[1].difficult,true);assert.equal(e.data.shapes[2].difficult,false);});
test('skip can undo and redo unfinished sequence position',()=>{const e=editor();e.skipPoint();assert.equal(e.pose.index,1);e.undo();assert.equal(e.pose.index,0);e.redo();assert.equal(e.pose.index,1);e.placePoint([70,30]);assert.equal(e.data.shapes[1].label,'right');});
test('last point skip and undo restores active sequence',()=>{const e=editor();e.pose.index=2;e.skipPoint();assert.equal(e.pose,null);e.undo();assert.equal(e.pose.index,2);});
test('selected point skip removes only that point, retaining sequence',()=>{const e=editor();e.placePoint([25,30]);e.selected=1;e.skipPoint();assert.equal(e.data.shapes.length,1);assert.equal(e.pose.index,1);e.undo();assert.equal(e.data.shapes.length,2);});
for(const axis of ['x','y'])test(axis+' mirror is reversible and isolated to one instance',()=>{const e=editor();e.placePoint([25,30]);e.data.shapes.push({...e.makeShape('left','point',[[12,12]],2)});e.selected=1;const before=JSON.stringify(e.data);e.mirrorPose(axis);assert.equal(e.data.shapes[1].label,'left');assert.deepEqual(Array.from(e.data.shapes[2].points[0]),[12,12]);assert.equal(e.data.shapes[1].points[0][axis==='x'?0:1],axis==='x'?75:70);e.mirrorPose(axis);assert.equal(JSON.stringify(e.data),before);});
for(const zoom of [.5,1,3])test('drag during sequential placement at zoom '+zoom,()=>{const e=editor();e.zoom=zoom;e.placePoint([25,30]);const evt=p=>({button:0,pointerId:1,clientX:p[0]*zoom,clientY:p[1]*zoom,preventDefault(){}});e.down(evt([25,30]));assert.equal(e.drag.kind,'vertex');e.move(evt([40,45]));e.up(evt([40,45]));assert.deepEqual(Array.from(e.data.shapes[1].points[0]),[40,45]);assert.equal(e.pose.index,1);assert.equal(e.data.shapes.length,2);});
test('cancel drag restores original point and sequence',()=>{const e=editor();e.placePoint([25,30]);const evt=p=>({button:0,pointerId:1,clientX:p[0],clientY:p[1],preventDefault(){}});e.down(evt([25,30]));e.move(evt([40,45]));e.cancelDrag();assert.deepEqual(Array.from(e.data.shapes[1].points[0]),[25,30]);assert.equal(e.pose.index,1);});
test('skip shortcut while checkbox focused and repeat guard',()=>{const e=editor(),event={target:{tagName:'INPUT',id:'occluded'},key:'k',preventDefault(){}};e.key(event);assert.equal(e.pose.index,1);e.key({...event,repeat:true});assert.equal(e.pose.index,1);});
test('typing does not trigger pose shortcuts',()=>{const e=editor();e.key({target:{tagName:'TEXTAREA'},key:'k'});assert.equal(e.pose.index,0);});
for(const task of ['detect','segment','obb','pose'])test(task+' object occlusion preserves difficulty, geometry and labels',()=>{
 const e=editor();e.project.task=task;e.pose=null;e.selected=0;e.data.shapes[0].flags={existing:true};e.data.shapes[0].difficult=true;
 const before=JSON.stringify(e.data.shapes[0].points);e.setObjectOccluded(true);
 assert.equal(e.data.shapes[0].flags.occluded,true);assert.equal(e.data.shapes[0].flags.existing,true);assert.equal(e.data.shapes[0].difficult,true);assert.equal(JSON.stringify(e.data.shapes[0].points),before);
 e.undo();assert.equal(e.data.shapes[0].flags.occluded,undefined);e.redo();assert.equal(e.data.shapes[0].flags.occluded,true);
});
test('classification occlusion keeps class flags untouched',()=>{const e=editor();e.project.task='classify';e.pose=null;e.data.flags={person:true};e.setObjectOccluded(true);assert.equal(e.data.occluded,true);assert.deepEqual(e.data.flags,{person:true});e.undo();assert.equal(e.data.occluded,undefined);});
test('batch object occlusion excludes keypoints and reports mixed selection',()=>{const e=editor();e.placePoint([20,20]);e.pose=null;e.selectedMany=[0,1];e.setObjectOccluded(true);assert.equal(e.data.shapes[0].flags.occluded,true);assert.equal(e.data.shapes[1].difficult,false);assert.equal(e.data.shapes[1].flags.occluded,undefined);});
test('object O shortcut while checkbox focused',()=>{const e=editor();e.project.task='detect';e.pose=null;e.selected=0;node('#object-occluded').checked=false;e.key({target:{tagName:'INPUT',id:'object-occluded'},key:'o',preventDefault(){}});assert.equal(e.data.shapes[0].flags.occluded,true);});
function labelEditor(){const e=editor();e.project={...e.project,root:'test-project',classes:['猫','狗']};e.activeClass='猫';e.classButtons=()=>{};return e;}
const tabEvent=(extra={})=>({key:'Tab',target:{tagName:'CANVAS'},preventDefault(){this.defaultPrevented=true;},...extra});
test('Tab cycles labels without changing pose, mode or existing annotation',()=>{const e=labelEditor(),before=JSON.stringify(e.data),pose=e.pose;e.key(tabEvent());assert.equal(e.activeClass,'狗');assert.equal(e.mode,'draw');assert.equal(e.pose,pose);assert.equal(JSON.stringify(e.data),before);e.key(tabEvent());assert.equal(e.activeClass,'猫');});
test('Shift Tab cycles backwards and key repeat does not skip multiple labels',()=>{const e=labelEditor();e.key(tabEvent({shiftKey:true}));assert.equal(e.activeClass,'狗');e.key(tabEvent({repeat:true}));assert.equal(e.activeClass,'狗');});
test('Tab works from placement selector and checkbox focus',()=>{const e=labelEditor();e.key(tabEvent({target:{tagName:'SELECT',id:'pose-placement'}}));assert.equal(e.activeClass,'狗');e.key(tabEvent({target:{tagName:'INPUT',type:'checkbox',id:'occluded'}}));assert.equal(e.activeClass,'猫');});
test('Tab preserves ordinary focus navigation when typing',()=>{const e=labelEditor();const event=tabEvent({target:{tagName:'INPUT',type:'text'}});e.key(event);assert.equal(e.activeClass,'猫');assert.equal(event.defaultPrevented,undefined);});
test('single-label Tab does not trap keyboard focus',()=>{const e=labelEditor();e.project.classes=['猫'];const event=tabEvent();e.key(event);assert.equal(event.defaultPrevented,undefined);});
test('number shortcuts preserve the unfinished skeleton',()=>{const e=labelEditor(),pose=e.pose;e.key({target:{tagName:'CANVAS'},key:'2'});assert.equal(e.activeClass,'狗');assert.equal(e.pose,pose);});
test('project preferences survive a new editor and are isolated by project',()=>{
 const values=new Map();context.window.localStorage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k)||null};
 const e=labelEditor();node('#pose-placement').value='sequence';e.mirrorX=true;e.mirrorY=true;e.activeClass='狗';e.rememberPreferences({mode:'draw'});
 const reopened=labelEditor();reopened.restorePreferences();assert.equal(reopened.activeClass,'狗');assert.equal(reopened.mirrorX,true);assert.equal(node('#pose-placement').value,'sequence');assert.equal(reopened.preferences.mode,'draw');
 reopened.project.root='other-project';reopened.restorePreferences();assert.equal(reopened.activeClass,'猫');assert.equal(reopened.mirrorX,false);assert.equal(node('#pose-placement').value,'template');
});
test('current target distinguishes next point from selected point',()=>{const e=editor();e.placePoint([25,30]);assert.equal(e.poseTarget().index,1);assert.equal(e.poseTarget().name,'right');e.selected=1;assert.equal(e.poseTarget().index,0);e.pose=null;assert.equal(e.poseTarget().name,'left');e.selected=-1;assert.equal(e.poseTarget(),null);});
const pointer=(x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,preventDefault(){}});
test('hover shows existing point then moving away restores current task without editing',()=>{
 const e=editor();e.placePoint([25,30]);e.dirty=false;const before=JSON.stringify(e.data),history=e.history.length;
 e.move(pointer(25,30));assert.equal(e.poseTarget().name,'left');
 e.move(pointer(60,70));assert.equal(e.selected,-1);assert.equal(e.poseTarget().name,'right');
 assert.equal(JSON.stringify(e.data),before);assert.equal(e.history.length,history);assert.equal(e.dirty,false);
});
test('leaving canvas restores task and preserves next-point occlusion',()=>{
 const e=editor();e.placePoint([25,30]);e.nextOccluded=true;e.move(pointer(25,30));e.leavePosePoint();
 assert.equal(e.poseTarget().name,'right');assert.equal(e.nextOccluded,true);assert.equal(e.canvas.title,'');
 e.setOccluded(false);assert.equal(e.data.shapes[1].difficult,false);assert.equal(e.nextOccluded,false);
});
test('drag remains current until release and moving away restores task',()=>{
 const e=editor();e.placePoint([25,30]);e.down(pointer(25,30));e.move(pointer(45,50));e.leavePosePoint();
 assert.equal(e.poseTarget().name,'left');e.up(pointer(45,50));e.move(pointer(70,75));
 assert.equal(e.poseTarget().name,'right');assert.deepEqual(Array.from(e.data.shapes[1].points[0]),[45,50]);
});
test('skip after leaving point skips pending task rather than deleting old point',()=>{
 const e=editor();e.placePoint([25,30]);e.move(pointer(25,30));e.move(pointer(70,75));e.skipPoint();
 assert.equal(e.pose.index,2);assert.equal(e.data.shapes[1].label,'left');assert.equal(e.data.shapes.length,2);
});
test('new point pointer-up immediately returns to the next task',()=>{
 const e=editor();e.down(pointer(25,30));e.move(pointer(25,30));e.up(pointer(25,30));
 assert.equal(e.pose.index,1);assert.equal(e.selected,-1);assert.equal(e.poseTarget().name,'right');
});
test('finished pose selection remains available after leaving canvas',()=>{
 const e=editor();e.placePoint([25,30]);e.pose=null;e.selected=1;e.leavePosePoint();
 assert.equal(e.selected,1);assert.equal(e.poseTarget().name,'left');
});
test('release outside image restores next task after dragging',()=>{
 const e=editor();e.placePoint([25,30]);e.down(pointer(25,30));e.up(pointer(120,110));
 assert.equal(e.selected,-1);assert.equal(e.poseTarget().name,'right');
});
console.log(`Passed ${passed} pose, occlusion and keyboard regression cases`);
