const assert=require('node:assert/strict');
const {matches,runWeights,runLabel}=require('./export-scope.js');
// A standalone conversion must never look like a project artifact, and a project
// conversion must not show on another project or on the no-project page.
assert.equal(matches({scope:'workspace'},undefined),true);
assert.equal(matches({scope:'workspace',project:'/workbench'},'/workbench'),false);
assert.equal(matches({scope:'project',project:'/a'},'/a'),true);
assert.equal(matches({scope:'project',project:'/b'},'/a'),false);
assert.equal(matches({project:'/a'},'/a'),true);          // records from before scope existed
assert.equal(matches({project:'/a'},undefined),false);
assert.equal(matches(undefined,'/a'),false);
assert.equal(matches({status:'idle',logs:[]},undefined),false);
// Handing the just-finished run to the conversion page, including Windows paths.
const records=[{name:'train_b',weights:'C:\\p\\runs\\train_b\\weights\\best.pt'},
 {name:'train_a',weights:'C:/p/runs/train_a/weights/best.pt'},{name:'no-weights'}];
assert.equal(runWeights(records,'C:/p/runs/train_a'),'C:/p/runs/train_a/weights/best.pt');
assert.equal(runWeights(records,'C:\\p\\runs\\train_b\\'),'C:\\p\\runs\\train_b\\weights\\best.pt');
assert.equal(runWeights(records,'C:/p/runs/gone'),records[0].weights);   // unknown run: newest
assert.equal(runWeights(records,null),records[0].weights);
assert.equal(runWeights([],'/a'),null);
assert.equal(runWeights(undefined,undefined),null);
// Readable dropdown labels keep the run name when it is not a training run.
assert.equal(runLabel('train_20261107_031500'),'训练 11-07 03:15');
assert.equal(runLabel('train_20261107_0315'),'train_20261107_0315');
assert.equal(runLabel('my-model'),'my-model');
assert.equal(runLabel(undefined),'');
console.log('Passed export scope matching, trained-run lookup and run labels.');