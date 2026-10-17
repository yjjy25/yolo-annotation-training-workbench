const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const context={window:{},document:{addEventListener(){}},structuredClone};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'editor.js'),'utf8'),context);
const proto=context.window.AnnotationEditor.prototype;
let passed=0;
function editor(shape,mode='select',zoom=1){
 const e=Object.create(proto);
 Object.assign(e,{image:{naturalWidth:100,naturalHeight:100},data:{shapes:[structuredClone(shape)]},
  selected:-1,selectedMany:[],project:{task:'detect'},mode,zoom,offset:[20,20],
  pending:[],pose:null,history:[],future:[],drag:null,shapeType:'rectangle',
  canvas:{focus(){},style:{},getBoundingClientRect(){return {left:0,top:0};},
   setPointerCapture(){this.captured=true;},hasPointerCapture(){return this.captured;},
   releasePointerCapture(){this.captured=false;}},
  render(){},list(){},status(){},hint(){},changed(){this.dirty=true;},callbacks:{toast(){}}});
 return e;
}
function event(e,p){return {clientX:20+p[0]*e.zoom,clientY:20+p[1]*e.zoom,button:0,pointerId:1,preventDefault(){}};}
function drag(e,from,to,kind){
 e.down(event(e,from));assert.equal(e.selected,0);assert.equal(e.drag?.kind,kind);
 e.move(event(e,to));e.up(event(e,to));assert.equal(e.drag,null);assert.equal(e.canvas.captured,false);
 passed++;
}
const box={shape_type:'rectangle',points:[[0,0],[100,0],[100,100],[0,100]]};
// A deselected corner remains reachable from the margin in either editing mode.
for(const zoom of [0.5,1,3])for(const mode of ['select','draw']){
 for(const [i,from,to] of [[0,[-3/zoom,-3/zoom],[15,15]],[1,[100+3/zoom,-3/zoom],[85,15]],
  [2,[100+3/zoom,100+3/zoom],[85,85]],[3,[-3/zoom,100+3/zoom],[15,85]]]){
  const e=editor(box,mode,zoom);drag(e,from,to,'vertex');
  assert.ok(e.data.shapes[0].points.some(p=>p[0]===to[0]&&p[1]===to[1]));
 }
 // A point can be dragged to the boundary, released, then grabbed from outside.
 for(const [edge,outside,inward] of [[[0,50],[-3/zoom,50],[20,50]],[[100,50],[100+3/zoom,50],[80,50]],
  [[50,0],[50,-3/zoom],[50,20]],[[50,100],[50,100+3/zoom],[50,80]]]){
  const e=editor({shape_type:'point',points:[[50,50]]},mode,zoom);
  drag(e,[50,50],edge,'vertex');e.selected=-1;
  drag(e,outside,inward,'vertex');assert.deepEqual(Array.from(e.data.shapes[0].points[0]),inward);
 }
}
// Boundary strokes select and move the entire object, including right/bottom.
for(const type of ['rectangle','polygon'])for(const [points,from,to] of [
 [[[70,20],[100,20],[100,80],[70,80]],[100,50],[80,50]],
 [[[0,20],[30,20],[30,80],[0,80]],[-3,50],[17,50]],
 [[[20,70],[80,70],[80,100],[20,100]],[50,100],[50,80]],
 [[[20,0],[80,0],[80,30],[20,30]],[50,-3],[50,17]],
]){
 const e=editor({shape_type:type,points});drag(e,from,to,'move');
 assert.notEqual(JSON.stringify(e.data.shapes[0].points),JSON.stringify(points));
 assert.ok(e.data.shapes[0].points.every(p=>p.every(v=>v>=0&&v<=100)));
}
// Rotation handles outside the image also work in drawing mode.
for(const mode of ['draw','select']){
 const e=editor({shape_type:'rotation',points:[[20,0],[80,0],[80,40],[20,40]]},mode);
 const handle=e.rotationHandle(e.data.shapes[0]);assert.ok(handle[1]<0);
 drag(e,handle,[70,20],'rotate');
}
// Blank margin clicks must never create annotations or an edit transaction.
for(const mode of ['draw','select']){
 const e=editor(box,mode);e.down(event(e,[-30,50]));
 assert.equal(e.drag,null);assert.equal(e.selected,-1);assert.equal(e.history.length,0);passed++;
}
// An open contour owns its clicks, even near existing handles.
{
 const e=editor(box,'draw');e.shapeType='polygon';e.pending=[[30,30],[40,30]];
 e.down(event(e,[0,0]));assert.equal(e.drag,null);assert.equal(e.pending.length,3);passed++;
}
console.log(`Passed ${passed} edge interaction cases`);
