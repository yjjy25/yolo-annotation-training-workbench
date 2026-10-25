const assert=require('node:assert/strict'),{member,explain}=require('./model-terms.js');
assert.match(member({type:'C2f'},'cv2').label,/融合/);
assert.match(member({type:'Detect'},'cv2').label,/位置回归/);
assert.match(member({type:'SPPF',pool_repeats:3},'m').detail,/3 次/);
assert.match(member({type:'C2f'},'m').label,/特征块组/);
assert.match(member({type:'C2PSA'},'m').label,/注意力/);
assert.match(member({type:'Bottleneck',residual:false},'cv1').detail,/未启用残差/);
assert.match(member({type:'Bottleneck',residual:true},'cv2').detail,/启用残差/);
assert.match(member({type:'DFL'},'conv').detail,/不参与训练/);
assert.match(member({type:'Unknown'},'cv1').detail,/暂无可靠/);
const info={module_tree:[{id:'model.12',type:'C2f'},{id:'model.12.m',type:'ModuleList'},{id:'model.12.m.0',type:'Bottleneck',residual:false},{id:'model.12.m.0.cv1',type:'Conv'},{id:'model.12.m.0.cv1.conv',type:'Conv2d'}]};
const result=explain({id:'model.12.m.0.cv1.conv'},info);
assert.equal(result.id,'model.12.m.0.cv1.conv');
assert.match(result.label,/内部特征块组.*第 1 项.*内部卷积 1.*卷积核/);
assert.equal(result.steps[2].key,'0');
assert.match(explain({id:'model.12.m.0.cv1.conv'},{}).label,/源码成员/,'legacy reports do not guess missing nested module types');
console.log('Model terms: contextual roles, pool sharing, residual flags, detection branches, zero-based paths and honest fallback passed.');

assert.match(member({type:'A2C2f'},'cv1').detail,/不把入口/);
assert.match(member({type:'Detect'},'one2one_cv2').label,/一对一/);

const {navigation}=require('./model-terms.js');
const head={id:'model.23',type:'Detect',execution:{input:[[1,64,16,16],[1,128,8,8],[1,256,4,4]]}};
const headLayers=[];
for(const branch of ['cv2','cv3','one2one_cv2','one2one_cv3'])for(let scale=0;scale<3;scale++){
 for(const [suffix,type,editable]of [['0.conv','Conv2d','kernel'],['0.bn','BatchNorm2d',null],['0.act','SiLU','activation'],['1.0.conv','Conv2d','kernel'],['2','Conv2d','kernel']])headLayers.push({id:`model.23.${branch}.${scale}.${suffix}`,type,editable,params:{}});
}
headLayers.push({id:'model.23.dfl.conv',type:'Conv2d',editable:null,params:{}});
const grouped=navigation(head,{layers:headLayers});
assert.equal(grouped.isHead,true);
assert.equal(grouped.groups.length,36);
const first=grouped.groups.find(g=>g.id==='model.23.cv2.0.0');
assert.equal(first.branch,'position');assert.equal(first.mode,'regular');assert.equal(first.scale,0);assert.equal(first.shape,'16 × 16');
assert.deepEqual(first.layers.map(l=>l.id),headLayers.slice(0,3).map(l=>l.id),'kernel, normalization and activation share their actual parent');
assert.equal(grouped.groups.find(g=>g.id==='model.23.cv3.1.1.0').label,'处理层 2 · 子层 1');
assert.equal(grouped.groups.find(g=>g.id==='model.23.one2one_cv3.2.2').mode,'one2one');
assert.equal(grouped.groups.find(g=>g.id==='model.23.one2one_cv3.2.2').branch,'category');
assert.deepEqual(grouped.other.map(l=>l.id),['model.23.dfl.conv']);
assert.deepEqual([...grouped.groups.flatMap(g=>g.layers).concat(grouped.other).map(l=>l.id)].sort(),headLayers.map(l=>l.id).sort(),'every real leaf remains accessible exactly once');
assert.equal(navigation({...head,execution:undefined},{layers:headLayers}).groups[0].shape,null,'historical reports never invent input sizes');
const simple=navigation({id:'model.0',type:'Conv'},{layers:[{id:'model.0.conv'},{id:'model.0.bn'},{id:'model.0.act'},{id:'model.1.conv'}]});
assert.equal(simple.groups.length,1);assert.equal(simple.groups[0].layers.length,3);
assert.equal(navigation({id:'model.10',type:'Upsample'},{layers:[{id:'model.10',editable:null}]}).groups[0].layers[0].id,'model.10');
console.log('Guided navigation: real ancestry, branch/mode isolation, runtime sizes, nested layers and complete read-only access passed.');
