const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'studio.js'),'utf8');
const code=source.slice(source.indexOf('let splitPending=null;'),source.indexOf("$('#training-form').onsubmit="));
const nodes=new Map(),requests=[],state={ready:true,project:{root:'a',counts:{total:86,checked:23,draft:0}}};
const ctx={state,splitKey:'',splitArgs:()=>({split_ratio:20}),$:s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);},rpc:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))};
vm.createContext(ctx);vm.runInContext(code,ctx);
const response=(images)=>({ready:true,train:images-5,val:5,images});
(async()=>{
 const first=ctx.refreshSplitPreview();for(let i=0;i<50;i++)ctx.refreshSplitPreview();assert.equal(requests.length,1,'state polling coalesces the same preview request');
 requests[0].resolve(response(23));await first;assert.match(nodes.get('#split-summary').textContent,/已审核 23 张/);
 state.project.counts.checked=86;const next=ctx.refreshSplitPreview();assert.equal(requests.length,2,'reviewed count invalidates cached split');requests[1].resolve(response(86));await next;
 assert.match(nodes.get('#training-split-summary').textContent,/已审核 86 张/);assert.match(nodes.get('#training-split-summary').textContent,/测试集 0 张/);
 state.project.counts.checked=85;const old=ctx.refreshSplitPreview();state.project={root:'b',counts:{checked:10}};const fresh=ctx.refreshSplitPreview();requests[3].resolve(response(10));await fresh;requests[2].resolve(response(85));await old;assert.match(nodes.get('#split-summary').textContent,/已审核 10 张/,'late old-project response cannot overwrite new preview');
 state.project.counts.checked=9;const fail=ctx.refreshSplitPreview();requests[4].reject(Error('temporary'));await fail;const retry=ctx.refreshSplitPreview();requests[5].resolve(response(9));await retry;assert.match(nodes.get('#split-summary').textContent,/已审核 9 张/,'failed previews retry');
 state.project=null;await ctx.refreshSplitPreview();assert.match(nodes.get('#training-split-summary').textContent,/尚未打开项目/);
 console.log('Split counts: reviewed updates, polling coalescing, project races, test disclosure and retry passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
