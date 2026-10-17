/* Retained native tools render into this page; no external tool window. */
class InlineToolPanel {
 constructor(api,rpc,back,toast){
  this.api=api;this.rpc=rpc;this.active=false;
  const section=document.createElement('section');section.id='page-advanced';section.className='inline-page';section.hidden=true;
  section.innerHTML='<div class="inline-toolbar"><div><strong>高级标注与导出</strong><span>原版工具直接集成，按 Esc 或关闭当前面板可返回</span></div><button id="inline-dismiss" title="取消当前弹窗或收起训练面板">关闭当前面板</button><button id="inline-save">保存标注</button><button id="inline-back" class="primary">返回简洁标注</button></div><div class="inline-surface"><img id="inline-frame" draggable="false" alt="集成的高级标注工具"><textarea id="inline-keyboard" aria-label="高级工具文字输入"></textarea><p id="inline-help">在此使用高级标注、交互分割、导出和更多训练参数。</p></div>';
  document.querySelector('main').append(section);this.section=section;this.image=section.querySelector('img');this.input=section.querySelector('textarea');this.surface=section.querySelector('.inline-surface');
  section.querySelector('#inline-back').onclick=back;
  section.querySelector('#inline-dismiss').onclick=()=>rpc('dismiss_advanced').catch(e=>toast(e.message));
  section.querySelector('#inline-save').onclick=()=>rpc('save_advanced').then(()=>toast('高级标注已保存。')).catch(e=>toast(e.message));
  api.onNativeFrame(frame=>{if(!frame)return;this.width=frame.width;this.height=frame.height;this.image.src='data:image/png;base64,'+frame.image;section.querySelector('#inline-help').hidden=true;});
  // Qt reports the scale it rasterised at. Pointer coordinates must use that
  // exact value, not the display's devicePixelRatio: they differ whenever Qt and
  // Chromium round the display scale differently, which shows up as the cursor
  // never landing on the shape the user aims at.
  this.scaleHint=window.devicePixelRatio||1;
  const loadScale=()=>{if(!api.diagnostics)return;Promise.resolve(api.diagnostics()).then(info=>{const value=Number(info?.inline?.render_scale);if(value>=1)this.scaleHint=value;}).catch(()=>{});};
  // Resizing the panel is what tells Qt how large to lay the retained tools out,
  // so only forward real size changes: echoing sub-pixel jitter back into Qt made
  // the captured frame oscillate between sizes.
  this.view=[0,0];
  const sync=()=>{if(!this.active)return;const r=this.surface.getBoundingClientRect();const width=Math.max(320,Math.round(r.width)),height=Math.max(240,Math.round(r.height));if(Math.abs(width-this.view[0])<2&&Math.abs(height-this.view[1])<2)return;this.view=[width,height];api.nativeView({visible:true,width,height});loadScale();};
  new ResizeObserver(sync).observe(this.surface);
  const send=(kind,e)=>{
   if(!this.width)return;
   const r=this.image.getBoundingClientRect(),scale=Math.min(r.width/this.width,r.height/this.height);
   const localX=e.clientX-r.left-(r.width-this.width*scale)/2,localY=e.clientY-r.top-(r.height-this.height*scale)/2;
   // local/scale = logical position in the Qt window; Qt wants rasterised pixels.
   const x=localX/scale*this.scaleHint,y=localY/scale*this.scaleHint;
   api.nativeInput({kind,x:Math.round(x),y:Math.round(y),button:e.button,buttons:e.buttons,ctrl:e.ctrlKey,shift:e.shiftKey,delta:e.deltaY||0});
  };
  this.image.onpointerdown=e=>{this.input.focus({preventScroll:true});this.image.setPointerCapture(e.pointerId);send('down',e);e.preventDefault();};
  this.image.onpointerup=e=>{send('up',e);if(this.image.hasPointerCapture(e.pointerId))this.image.releasePointerCapture(e.pointerId);};
  this.image.onpointermove=e=>send('move',e);this.image.ondblclick=e=>send('double',e);this.image.oncontextmenu=e=>e.preventDefault();this.image.addEventListener('wheel',e=>{send('wheel',e);e.preventDefault();},{passive:false});
  this.input.addEventListener('input',()=>{if(!this.composing&&this.input.value){api.nativeInput({kind:'text',text:this.input.value});this.input.value='';}});
  this.input.addEventListener('compositionstart',()=>this.composing=true);this.input.addEventListener('compositionend',()=>{this.composing=false;if(this.input.value){api.nativeInput({kind:'text',text:this.input.value});this.input.value='';}});
  this.input.onkeydown=e=>{if(e.isComposing||e.key==='Process'||e.key==='Dead'||e.keyCode===229)return;if(e.key.length!==1||e.ctrlKey||e.metaKey){api.nativeInput({kind:'key',key:e.key,ctrl:e.ctrlKey||e.metaKey,shift:e.shiftKey});e.preventDefault();}};
 }
 async show(panel,name){this.active=true;this.view=[0,0];const r=this.surface.getBoundingClientRect();await this.rpc('advanced',{panel,name,width:Math.round(r.width),height:Math.round(r.height)});}
 hide(){this.active=false;this.view=[0,0];this.api.nativeView({visible:false});}
}
window.InlineToolPanel=InlineToolPanel;
