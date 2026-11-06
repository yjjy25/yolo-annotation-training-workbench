const assert=require('node:assert/strict');
globalThis.ModelGraph=require('./model-graph.js');
const space=require('./model-space.js');
assert.deepEqual(space.tensors([[[1,16,32,32]],[1,3,64,64]]),[[1,16,32,32],[1,3,64,64]]);
assert.equal(space.summary([1,16,32,32]),'32 × 32 · 16 通道');
assert.equal(space.summary(null),'未测得');
assert.equal(space.summary([1,84,1024]),'未测得');
const nodes=[{id:'model.0',from:-1,section:'backbone',execution:{output:[1,16,32,32]}},
 {id:'model.1',from:-1,section:'backbone',execution:{output:[1,32,16,16]}},
 {id:'model.2',from:[0,1],section:'fusion',execution:null}];
const scene=space.scene(nodes,{imgsz:64});
assert.deepEqual(scene.links.map(e=>[e.source,e.target]),[[0,1],[0,2],[1,2]]);
assert.equal(scene.items[2].shape,null,'missing measurement never reuses upstream dimensions');
assert.deepEqual(scene.input,[1,3,64,64]);
const [w,h,c]=space.dimensions([1,16,32,64]);assert.ok(w>h&&c>0);
const camera={yaw:0,pitch:0,scale:1,x:0,y:0};
assert.deepEqual(space.project([10,20,30],camera,200,100),[110,70,30]);
const turned=space.project([10,20,30],{...camera,yaw:Math.PI/2},200,100);
assert.ok(Math.abs(turned[0]-130)<1e-8&&Math.abs(turned[2]+10)<1e-8);
assert.throws(()=>space.scene([{id:'model.0',from:2}]),/非法/);
const tree=[{id:'model.4',type:'C2f'},{id:'model.4.m',type:'ModuleList'}],leaves=[];
for(let i=0;i<2;i++){
 tree.push({id:`model.4.m.${i}`,type:'Bottleneck',residual:true});
 for(const key of ['cv1','cv2']){
  const id=`model.4.m.${i}.${key}`;tree.push({id,type:'Conv'});
  for(const [suffix,type]of [['conv','Conv2d'],['bn','BatchNorm2d'],['act','SiLU']]){const row={id:id+'.'+suffix,type,params:{kernel:[3,3]}};tree.push(row);leaves.push(row);}
 }
}
const info={module_tree:tree,layers:leaves};
const hierarchy=space.hierarchy(info,'model.4');
assert.equal(hierarchy.blocks.length,2,'both actual repeated blocks must survive');
assert.equal(hierarchy.units.length,4);
assert.equal(hierarchy.leaves.length,12);
assert.equal(hierarchy.depth,4);
const detailed=space.detailScene(info,'model.4');
assert.equal(detailed.items.length,12,'every operator has a separate 3D plate');
assert.equal(detailed.shelves.length,2);
assert.deepEqual(detailed.links,[],'module registration must not invent internal dataflow');
assert.deepEqual(new Set(detailed.items.map(n=>n.path)),new Set(leaves.map(n=>n.id)));
const scoped=space.detailScene(info,'model.4.m.1');
assert.equal(scoped.items.length,6);
assert.ok(scoped.items.every(n=>n.path.startsWith('model.4.m.1.')));
assert.equal(space.hierarchy(info,'model.40').leaves.length,0,'prefixes cannot select a different module');
console.log('3D hierarchy: repeated blocks, one plate per operator, subtree isolation, native edges and measured IO passed.');
