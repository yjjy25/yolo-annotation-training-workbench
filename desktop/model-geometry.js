/* Geometry edits are atomic; the backend remains the authority for measured sizes. */
((root)=>{
 function draft(original,current,kernel,policy,padding,stride){
  if(String(padding).trim()===''&&policy==='manual')throw Error('请填写边缘填充。');
  kernel=Number(kernel);padding=Number(padding);stride=Number(stride);
  if(policy==='preserve'){
   stride=original.stride[0];
   padding=original.padding[0]+(original.dilation?.[0]||1)*(kernel-original.kernel[0])/2;
  }
  if(![1,3,5,7].includes(kernel)||!Number.isInteger(padding)||padding<0||padding>16||![1,2].includes(stride))throw Error('核大小、填充或步幅不在支持范围内。');
  return {kernel,padding,stride,policy};
 }
 function predict(input,value,dilation=[1,1]){
  if(!input)return null;
  return input.slice(-2).map((n,i)=>Math.floor((n+2*value.padding-dilation[i]*(value.kernel-1)-1)/value.stride+1));
 }
 function same(params,value){return params.kernel.every(n=>n===value.kernel)&&params.padding.every(n=>n===value.padding)&&params.stride.every(n=>n===value.stride);}
 const api={draft,predict,same};root.ModelGeometry=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
