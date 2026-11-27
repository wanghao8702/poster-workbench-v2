'use strict';
// Layer list, properties panel, context menu and toolbar for PosterEditor. All edits go through PosterEditor.
const EditorPanel=(()=>{
 const E=PosterEditor,C=EditorCore;
 const $=id=>document.getElementById(id);
 /* Same shapes as the sprite in index.html; every icon in the app comes from there. */
 const ICON={eye:'<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-eye"/></svg>',eyeOff:'<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-eye-off"/></svg>',lock:'<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-lock"/></svg>',unlock:'<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-unlock"/></svg>',download:'<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-download"/></svg>'};
 const KIND_LABEL={split:'拆层',image:'图片',text:'文字',shape:'形状'};
 let opts={},menuId=null,propsFor=null,swatches=['#15171c','#ffffff'],fontOk={};
 const thumbs=new Map();   // id -> {key, canvas}

 function h(tag,attrs={},...children){
  const el=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){if(v===false||v==null)continue;if(k==='class')el.className=v;else if(k==='text')el.textContent=v;else if(k.startsWith('on'))el[k]=v;else el.setAttribute(k,v===true?'':v);}
  el.append(...children.filter(c=>c!=null));return el;
 }
 const busy=()=>opts.isBusy?.();
 const download=(blob,name)=>{if(!blob)return;const url=URL.createObjectURL(blob);const a=h('a',{href:url,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);};

 /* ---------- fonts and colours ---------- */
 function checkFonts(){
  const ctx=document.createElement('canvas').getContext('2d'),sample='海报工作台 Poster 123';
  for(const f of C.FONTS){
   const first=f.css.split(',')[0];
   const widths=['monospace','serif'].map(base=>{ctx.font=`32px ${base}`;const a=ctx.measureText(sample).width;ctx.font=`32px ${first}, ${base}`;return [a,ctx.measureText(sample).width];});
   fontOk[f.name]=widths.some(([a,b])=>Math.abs(a-b)>0.5);
  }
 }
 function paletteFrom(el){
  // A few dominant colours of the backdrop, so text and shapes can match the poster.
  try{
   const c=document.createElement('canvas');c.width=c.height=24;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(el,0,0,24,24);
   const px=ctx.getImageData(0,0,24,24).data,count=new Map();
   for(let i=0;i<px.length;i+=4){if(px[i+3]<200)continue;const key=[px[i],px[i+1],px[i+2]].map(v=>Math.min(7,v>>5)).join(',');count.set(key,(count.get(key)||0)+1);}
   return [...count.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k])=>'#'+k.split(',').map(v=>(Number(v)*32+16).toString(16).padStart(2,'0')).join(''));
  }catch(e){return [];}
 }

 /* ---------- layer list ---------- */
 function thumb(obj){
  const key=JSON.stringify(E.describe(obj));const cached=thumbs.get(obj.pe.id);
  if(cached&&cached.key===key)return cached.canvas;
  const canvas=h('canvas',{class:'layer-thumb'});canvas.width=canvas.height=120;
  const src=E.thumbnail(obj,104);
  if(src){const ctx=canvas.getContext('2d');const s=Math.min(104/src.width,104/src.height,1);ctx.drawImage(src,(120-src.width*s)/2,(120-src.height*s)/2,src.width*s,src.height*s);}
  thumbs.set(obj.pe.id,{key,canvas});return canvas;
 }
 function iconButton(cls,label){return h('button',{type:'button',class:`icon-btn ${cls}`,'aria-label':label,title:label});}
 function row(obj,list){
  const p=obj.pe,active=E.selected()===obj;
  const el=h('article',{class:`layer-row${active?' selected':''}${obj.visible?'':' off'}${p.locked?' locked':''}`,'data-id':p.id});
  const handle=h('span',{class:'drag-handle',title:'按住上下拖动，调整叠放顺序','aria-hidden':'true'});
  handle.addEventListener('pointerdown',e=>startRowDrag(e,el));
  const eye=iconButton('eye',`${obj.visible?'隐藏':'显示'}这一层：${p.name}`);eye.innerHTML=obj.visible?ICON.eye:ICON.eyeOff;eye.setAttribute('aria-pressed',String(obj.visible));
  eye.onclick=e=>{e.stopPropagation();if(!busy())E.update(p.id,{visible:!obj.visible});};
  const name=h('input',{class:'layer-name',value:p.name||'',maxlength:30,spellcheck:'false','aria-label':`${KIND_LABEL[p.kind]}图层名称`});
  name.onchange=()=>E.update(p.id,{name:name.value.trim()||KIND_LABEL[p.kind]});
  name.onkeydown=e=>{if(e.key==='Enter'||e.key==='Escape')name.blur();};
  const natural=E.imageInfo(obj);
  const bits=[KIND_LABEL[p.kind]];
  if(p.kind==='text')bits.push(`“${(obj.text||'').replace(/\s+/g,' ').slice(0,10)}”`);
  if(natural&&C.upscale(obj)>1.5)bits.push(`放大 ${Math.round(C.upscale(obj)*100)}%`);
  if(!obj.visible)bits.push('已隐藏');else if(p.locked)bits.push('已锁定');
  const meta=h('div',{class:'layer-meta'},name,h('span',{class:'layer-sub',text:bits.join(' · ')}));
  const lock=iconButton('lock',`${p.locked?'解锁':'锁定'}：${p.name}`);lock.innerHTML=p.locked?ICON.lock:ICON.unlock;lock.setAttribute('aria-pressed',String(!!p.locked));
  lock.onclick=e=>{e.stopPropagation();if(!busy())E.update(p.id,{locked:!p.locked});};
  const dl=iconButton('',`下载这一层：${p.name}`);dl.innerHTML=ICON.download;
  dl.onclick=async e=>{e.stopPropagation();download(await E.objectBlob(p.id),`${p.name||'layer'}.png`);};
  el.append(handle,eye,thumb(obj),meta,lock,dl);
  el.onclick=e=>{if(busy()||e.target.closest('button,input,.drag-handle'))return;
   if(!obj.visible)E.update(p.id,{visible:true});
   if(p.locked){opts.notify?.('这一层已锁定，点右侧的锁图标解锁后可以移动和修改。');return;}
   E.select(p.id);};
  el.addEventListener('contextmenu',e=>{if(e.target===name&&document.activeElement===name)return;e.preventDefault();if(busy())return;openMenu(p.id,e.clientX,e.clientY);});
  list.append(el);
 }
 function renderList(){
  const list=$('layer-list');
  if(list.contains(document.activeElement)&&document.activeElement.matches('input'))return; // do not steal focus while renaming
  list.replaceChildren();
  const all=E.objects();
  for(const obj of [...all].reverse())row(obj,list);
  for(const id of [...thumbs.keys()])if(!all.some(o=>o.pe.id===id))thumbs.delete(id);
  const shown=all.filter(o=>o.visible).length;
  $('layer-count').textContent=`${all.length} 个图层`;
  const s=E.scene();$('layer-summary').textContent=`显示 ${shown} · 隐藏 ${all.length-shown} · ${s.width} × ${s.height}`;
 }
 let rowDrag=null;
 function startRowDrag(event,el){
  if(busy()||event.button!==0||rowDrag)return;
  event.preventDefault();event.stopPropagation();closeMenu();
  rowDrag={pointerId:event.pointerId,el,moved:false};el.classList.add('dragging');
  const list=$('layer-list');
  const move=e=>{
   if(e.pointerId!==rowDrag?.pointerId)return;
   const rect=list.getBoundingClientRect();
   if(e.clientY<rect.top+28)list.scrollTop-=12;else if(e.clientY>rect.bottom-28)list.scrollTop+=12;
   const target=[...list.children].find(o=>o!==el&&e.clientY<o.getBoundingClientRect().top+o.offsetHeight/2);
   if(target?(el.nextSibling===target):(el===list.lastElementChild))return;
   target?list.insertBefore(el,target):list.append(el);rowDrag.moved=true;
  };
  const end=e=>{
   if(e.pointerId!==rowDrag?.pointerId)return;
   el.classList.remove('dragging');
   const moved=rowDrag.moved;rowDrag=null;
   document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.removeEventListener('pointercancel',end);
   if(moved){const ids=[...list.children].map(c=>c.dataset.id),at=ids.indexOf(el.dataset.id);E.reorder(el.dataset.id,ids.length-1-at);}
  };
  document.addEventListener('pointermove',move);document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);
 }

 /* ---------- context menu ---------- */
 function openMenu(id,x,y){
  const obj=E.objects().find(o=>o.pe.id===id);if(!obj)return;
  menuId=id;const menu=$('layer-menu'),all=E.objects(),at=all.indexOf(obj);
  const item=a=>menu.querySelector(`[data-action="${a}"]`);
  item('top').disabled=item('up').disabled=at>=all.length-1;
  item('bottom').disabled=item('down').disabled=at<=0;
  item('hide').textContent=obj.visible?'隐藏':'显示';
  item('lock').textContent=obj.pe.locked?'解锁':'锁定';
  item('reset').disabled=obj.pe.kind!=='split';
  item('reset').title=obj.pe.kind==='split'?'':'只有拆层图层有原始位置';
  item('delete').disabled=obj.pe.kind==='split';
  item('delete').title=obj.pe.kind==='split'?'拆层图层只能隐藏':'';
  menu.hidden=false;
  menu.style.left=`${Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))}px`;
  menu.style.top=`${Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
 }
 function closeMenu(){if(!$('layer-menu').hidden){$('layer-menu').hidden=true;menuId=null;}}
 async function menuAction(action){
  const id=menuId;closeMenu();if(!id||busy())return;
  const obj=E.objects().find(o=>o.pe.id===id);if(!obj)return;
  if(['top','up','down','bottom'].includes(action))E.reorder(id,action);
  else if(action==='hide')E.update(id,{visible:!obj.visible});
  else if(action==='lock')E.update(id,{locked:!obj.pe.locked});
  else if(action==='reset')E.reset(id);
  else if(action==='copy')E.duplicate(id);
  else if(action==='delete')E.remove(id);
  else if(action==='download')download(await E.objectBlob(id),`${obj.pe.name||'layer'}.png`);
 }

 /* ---------- properties ---------- */
 /* ---------- style bar (above the canvas) ----------
    Position, size and rotation are left to the mouse. Only what the mouse cannot do is here:
    text and shape styling, and opacity for anything the user added. Split layers get nothing. */
 const STYLED=['text','shape','image'];
 function num(key,attrs={}){return h('input',{type:'number',class:'ctx-num','data-key':key,step:attrs.step||1,min:attrs.min,max:attrs.max,'aria-label':attrs.label||key,title:attrs.label||''});}
 function colorInput(key,label,withSwatches){
  const picker=h('input',{type:'color','data-key':key,'aria-label':label,title:label});
  if(!withSwatches)return picker;
  // Colours are set from script: the page's CSP forbids inline style attributes, not element.style.
  const sw=h('span',{class:'ctx-swatches'},...swatches.map(c=>{const b=h('button',{type:'button',class:'swatch','data-color':c,title:c,'aria-label':`使用颜色 ${c}`});b.style.backgroundColor=c;return b;}));
  return h('span',{class:'ctx-color'},picker,sw);
 }
 const toggle=(key,text,label,cls='')=>h('label',{class:`ctx-toggle ${cls}`,title:label},h('input',{type:'checkbox','data-key':key,'aria-label':label}),text);
 const ctxRow=(label,...items)=>h('label',{class:'ctx-row'},h('span',{text:label}),...items);
 // A small drop-down panel; the summary shows its name, the body holds the less frequent settings.
 const pop=(name,...body)=>h('details',{class:'ctx-pop'},h('summary',{text:name}),h('div',{class:'ctx-pop-body'},...body));
 const sep=()=>h('i',{class:'divider','aria-hidden':'true'});
 function opacityPop(){
  return pop('透明度',ctxRow('不透明度',h('input',{type:'range','data-key':'opacity',min:0,max:100,step:1,'aria-label':'不透明度'}),h('output',{'data-key':'opacityText'})));
 }
 function strokePop(max){
  return pop('描边',h('label',{class:'ctx-row'},h('input',{type:'checkbox','data-key':'strokeOn'}),h('span',{text:'显示描边'})),
   ctxRow('颜色',colorInput('stroke','描边颜色')),ctxRow('粗细',num('strokeWidth',{min:0,max,label:'描边粗细'})));
 }
 function buildBar(obj){
  const bar=$('style-bar'),previous=propsFor;
  const target=obj&&STYLED.includes(obj.pe.kind)?obj:null;
  propsFor=target?target.pe.id:null; // set first: recording below refreshes the panel, which must not rebuild again
  // A value typed into the bar is already applied live; record it before its input disappears with the old selection.
  if(previous&&bar.contains(document.activeElement)&&E.objects().some(o=>o.pe.id===previous))E.commitNow();
  bar.replaceChildren();
  if(!target){
   bar.append(h('span',{class:'ctx-empty',text:'选中文字、形状或添加的图片后，这里显示样式'}));
   return;
  }
  const k=target.pe.kind;
  if(k==='text'){
   const fonts=h('select',{class:'ctx-select','data-key':'fontName','aria-label':'字体'},...C.FONTS.map(f=>h('option',{value:f.name,text:fontOk[f.name]===false?`${f.name}（本机未安装）`:f.name})));
   const align=h('select',{class:'ctx-select','data-key':'textAlign','aria-label':'对齐'},h('option',{value:'left',text:'左对齐'}),h('option',{value:'center',text:'居中'}),h('option',{value:'right',text:'右对齐'}));
   bar.append(fonts,num('fontSize',{min:4,max:1000,label:'字号'}),colorInput('fill','文字颜色',true),sep(),
    toggle('bold','B','加粗'),toggle('italic','I','斜体','ctx-italic'),align,sep(),
    strokePop(100),
    pop('阴影',h('label',{class:'ctx-row'},h('input',{type:'checkbox','data-key':'shadowOn'}),h('span',{text:'显示阴影'})),
     ctxRow('颜色',colorInput('shadowColor','阴影颜色')),ctxRow('模糊',num('shadowBlur',{min:0,max:200,label:'阴影模糊'})),ctxRow('偏移',num('shadowOffset',{min:-200,max:200,label:'阴影偏移'}))),
    pop('间距',ctxRow('行距',num('lineHeight',{min:0.5,max:5,step:0.1,label:'行距'})),ctxRow('字距',num('charSpacing',{min:-500,max:2000,step:10,label:'字距'}))),
    opacityPop());
  }else if(k==='shape'){
   bar.append(h('span',{class:'ctx-label',text:'填充'}),colorInput('fill','填充颜色',true),sep(),strokePop(200));
   if(target.pe.shape==='roundrect')bar.append(h('span',{class:'ctx-label',text:'圆角'}),num('rx',{min:0,label:'圆角'}));
   bar.append(opacityPop());
  }else{
   bar.append(opacityPop(),h('span',{class:'ctx-note','data-key':'imageNote'}));
  }
  syncBar(target);
 }
 const toHex=c=>{if(typeof c!=='string')return '#000000';if(/^#[0-9a-f]{6}$/i.test(c))return c;if(/^#[0-9a-f]{3}$/i.test(c))return '#'+[...c.slice(1)].map(x=>x+x).join('');const m=c.match(/\d+/g);return m&&m.length>=3?'#'+m.slice(0,3).map(v=>Number(v).toString(16).padStart(2,'0')).join(''):'#000000';};
 function syncBar(obj){
  const bar=$('style-bar');if(!obj||obj.pe.id!==propsFor)return;
  const s=obj.shadow;
  const values={opacity:Math.round(obj.opacity*100),fontName:obj.pe.fontName,fontSize:Math.round(obj.fontSize||0),
   lineHeight:obj.lineHeight,charSpacing:obj.charSpacing,fill:toHex(obj.fill),bold:obj.fontWeight==='bold',italic:obj.fontStyle==='italic',
   textAlign:obj.textAlign,strokeOn:obj.strokeWidth>0,stroke:toHex(obj.stroke||'#ffffff'),strokeWidth:obj.strokeWidth,
   shadowOn:!!s,shadowColor:toHex(s?.color||'#000000'),shadowBlur:s?.blur??8,shadowOffset:s?.offsetY??4,rx:Math.round(obj.rx||0)};
  for(const input of bar.querySelectorAll('input[data-key],select[data-key]')){
   const key=input.dataset.key;if(input===document.activeElement||values[key]===undefined)continue;
   if(input.type==='checkbox')input.checked=!!values[key];else input.value=values[key];
  }
  const out=bar.querySelector('[data-key=opacityText]');if(out)out.textContent=`${values.opacity}%`;
  const note=bar.querySelector('[data-key=imageNote]'),natural=E.imageInfo(obj);
  if(note&&natural){
   const up=C.upscale(obj);
   note.textContent=up>1.5?`已放大到 ${Math.round(up*100)}%，可能模糊，二维码可能扫不出`:`原图 ${natural.w} × ${natural.h} px`;
   note.classList.toggle('warn',up>1.5);
  }
  for(const input of bar.querySelectorAll('input,select'))input.disabled=!!obj.pe.locked||busy();
 }
 function apply(input,record){
  const obj=E.selected();const key=input.dataset.key;if(!obj||!key||obj.pe.id!==propsFor||busy())return;
  const id=obj.pe.id,v=input.type==='checkbox'?input.checked:(input.type==='number'||input.type==='range')?Number(input.value):input.value;
  if((input.type==='number'||input.type==='range')&&!Number.isFinite(v))return;
  const bar=$('style-bar'),get=k=>bar.querySelector(`[data-key=${k}]`);
  const props={};
  switch(key){
   case 'opacity':props.opacity=Math.max(0,Math.min(100,v))/100;{const out=get('opacityText');if(out)out.textContent=`${Math.round(v)}%`;}break;
   case 'bold':props.fontWeight=v?'bold':'normal';break;
   case 'italic':props.fontStyle=v?'italic':'normal';break;
   case 'strokeOn':props.strokeWidth=v?Math.max(2,Math.round((obj.fontSize||40)/20)):0;props.stroke=v?get('stroke').value:null;break;
   case 'stroke':props.stroke=v;if(!obj.strokeWidth)props.strokeWidth=2;get('strokeOn').checked=true;break;
   case 'strokeWidth':props.strokeWidth=Math.max(0,v);if(v>0&&!obj.stroke)props.stroke=get('stroke').value;get('strokeOn').checked=v>0;break;
   case 'shadowOn':case 'shadowColor':case 'shadowBlur':case 'shadowOffset':{
    const on=key==='shadowOn'?v:true;
    if(key!=='shadowOn')get('shadowOn').checked=true;
    const offset=Number(get('shadowOffset').value)||0;
    props.shadow=on?new fabric.Shadow({color:get('shadowColor').value,blur:Number(get('shadowBlur').value)||0,offsetX:Math.round(offset/2),offsetY:offset}):null;break;}
   default:props[key]=v;
  }
  E.update(id,props,{record});
 }
 function placePop(details){
  const body=details.querySelector('.ctx-pop-body'),r=details.querySelector('summary').getBoundingClientRect();
  body.style.top=`${Math.round(r.bottom+4)}px`;
  body.style.left=`${Math.round(Math.max(8,Math.min(r.left,innerWidth-body.offsetWidth-8)))}px`;
 }
 function closePops(except){for(const d of $('style-bar').querySelectorAll('details[open]'))if(d!==except)d.open=false;}

 /* ---------- toolbar ---------- */
 function refresh(){
  const open=E.isOpen(),b=busy();
  $('editor-toolbar').hidden=!open;
  $('style-bar').hidden=!open;
  if(!open){propsFor=null;$('style-bar').replaceChildren();return;}
  renderList();
  $('undo').disabled=b||!E.canUndo();$('redo').disabled=b||!E.canRedo();
  const obj=E.selected();
  $('reset-layer').disabled=b||!obj||obj.pe.kind!=='split';
  $('select-all').disabled=b||E.objects().every(o=>o.visible);
  onSelection(obj);
 }
 function onSelection(obj){
  if(!E.isOpen())return;
  const target=obj&&STYLED.includes(obj.pe.kind)?obj.pe.id:null;
  if(target!==propsFor||!$('style-bar').childElementCount)buildBar(obj);else syncBar(obj);
  $('selected-layer').textContent=obj?`已选中：${obj.pe.name||KIND_LABEL[obj.pe.kind]}`:'点击画面里的元素选中';
  $('layer-position').textContent=obj?`${KIND_LABEL[obj.pe.kind]} · X ${Math.round(obj.getBoundingRect().left)} / Y ${Math.round(obj.getBoundingRect().top)}`:'';
  $('reset-layer').disabled=busy()||!obj||obj.pe.kind!=='split';
  for(const r of $('layer-list').children)r.classList.toggle('selected',r.dataset.id===obj?.pe.id);
 }
 function init(options){
  opts=options;checkFonts();
  const bar=$('style-bar');
  bar.oninput=e=>apply(e.target,false);
  bar.onchange=e=>apply(e.target,true);
  bar.onclick=e=>{const sw=e.target.closest('.swatch');if(sw){const input=sw.closest('.ctx-color').querySelector('input[type=color]');input.value=sw.dataset.color;apply(input,true);}};
  // One drop-down open at a time; a click anywhere outside closes it.
  // The bar scrolls sideways instead of wrapping, so drop-downs are placed against the window, not the bar.
  bar.addEventListener('toggle',e=>{if(e.target.open){closePops(e.target);placePop(e.target);}},true);
  bar.addEventListener('scroll',()=>closePops());addEventListener('resize',()=>closePops());
  document.addEventListener('pointerdown',e=>{if(!e.target.closest('.ctx-pop'))closePops();},true);
  bar.addEventListener('keydown',e=>{if(e.key==='Escape'){const d=e.target.closest('details');if(d){d.open=false;d.querySelector('summary').focus();}}});
  const guard=fn=>(...a)=>{if(busy()||!E.isOpen())return;Promise.resolve(fn(...a)).catch(e=>opts.notify?.(e.message,true));};
  $('add-image-input').onchange=guard(async()=>{const f=$('add-image-input').files[0];$('add-image-input').value='';if(f)await E.addImage(f);});
  $('add-text').onclick=guard(()=>E.addText());
  $('add-shape').onchange=guard(()=>{const v=$('add-shape').value;$('add-shape').value='';if(v)return E.addShape(v);});
  $('undo').onclick=guard(()=>E.undo());$('redo').onclick=guard(()=>E.redo());
  $('reset-layer').onclick=guard(()=>{const o=E.selected();if(o)E.reset(o.pe.id);});
  $('reset-all').onclick=guard(()=>{E.resetAll();opts.notify?.('拆层图层已恢复原始位置和大小。');});
  $('select-all').onclick=guard(()=>E.showAll());
  $('reverse-stack').onclick=guard(()=>{E.reverse();opts.notify?.('已反转图层叠放顺序。');});
  $('layer-menu').onclick=e=>{const b=e.target.closest('button[data-action]');if(b&&!b.disabled)menuAction(b.dataset.action);};
  $('layer-menu').addEventListener('keydown',e=>{
   const items=[...$('layer-menu').querySelectorAll('button:not(:disabled)')],at=items.indexOf(document.activeElement);
   if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();items[(at+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}
   if(e.key==='Escape'){e.preventDefault();closeMenu();}
  });
  document.addEventListener('pointerdown',e=>{if(!e.target.closest('#layer-menu'))closeMenu();},true);
  addEventListener('resize',closeMenu);$('layer-list').addEventListener('scroll',closeMenu);
 }
 function setPalette(el){swatches=['#15171c','#ffffff',...(el?paletteFrom(el):[])];propsFor=null;}
 return {init,refresh,onSelection,openMenu,closeMenu,setPalette,menuOpen:()=>!$('layer-menu').hidden,fontOk:()=>({...fontOk})};
})();
