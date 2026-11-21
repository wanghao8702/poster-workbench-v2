'use strict';
// Layer list, properties panel, context menu and toolbar for PosterEditor. All edits go through PosterEditor.
const EditorPanel=(()=>{
 const E=PosterEditor,C=EditorCore;
 const $=id=>document.getElementById(id);
 const ICON={
  eye:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.5 6.6C3.8 8.3 2 12 2 12s3.6 7 10 7a10 10 0 0 0 4.4-1"/></svg>',
  lock:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
  download:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>'
 };
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
 function field(label,input,extra){return h('label',{class:'prop-field'},h('span',{text:label}),input,extra||null);}
 function num(key,attrs={}){return h('input',{type:'number',class:'size-select','data-key':key,step:attrs.step||1,min:attrs.min,max:attrs.max});}
 function colorInput(key){
  const picker=h('input',{type:'color','data-key':key,'aria-label':'选择颜色'});
  // Colours are set from script: the page's CSP forbids inline style attributes, not element.style.
  const sw=h('span',{class:'prop-swatches'},...swatches.map(c=>{const b=h('button',{type:'button',class:'swatch','data-color':c,title:c,'aria-label':`使用颜色 ${c}`});b.style.background=c;return b;}));
  return h('span',{class:'prop-color'},picker,sw);
 }
 function buildProps(obj){
  const box=$('props'),previous=propsFor;
  propsFor=obj?obj.pe.id:null; // set first: recording below refreshes the panel, which must not rebuild again
  // A value typed into the panel is already applied live; record it before its input disappears with the old selection.
  if(previous&&box.contains(document.activeElement)&&E.objects().some(o=>o.pe.id===previous))E.commitNow();
  box.replaceChildren();
  box.hidden=!obj;if(!obj)return;
  const k=obj.pe.kind;
  box.append(h('div',{class:'props-title'},h('strong',{text:`${KIND_LABEL[k]}属性`}),h('span',{text:obj.pe.name||''})));
  const grid=h('div',{class:'prop-grid'},field('X',num('x')),field('Y',num('y')),field('宽',num('w',{min:1})),field('高',num('h',{min:1})),
   field('旋转°',num('angle',{min:-360,max:360})),field('不透明 %',num('opacity',{min:0,max:100})));
  box.append(grid);
  if(k==='text'){
   const fonts=h('select',{class:'size-select','data-key':'fontName'},...C.FONTS.map(f=>h('option',{value:f.name,text:fontOk[f.name]===false?`${f.name}（本机未安装）`:f.name})));
   box.append(field('文字内容',h('textarea',{class:'prop-text','data-key':'text',maxlength:2000,rows:3})),
    h('div',{class:'prop-grid'},field('字体',fonts),field('字号',num('fontSize',{min:4,max:1000})),
     field('行距',num('lineHeight',{min:0.5,max:5,step:0.1})),field('字距',num('charSpacing',{min:-500,max:2000,step:10}))),
    field('颜色',colorInput('fill')),
    h('div',{class:'prop-toggles'},
     h('label',{},h('input',{type:'checkbox','data-key':'bold'}),'加粗'),h('label',{},h('input',{type:'checkbox','data-key':'italic'}),'斜体'),
     h('select',{class:'size-select','data-key':'textAlign','aria-label':'对齐'},h('option',{value:'left',text:'左对齐'}),h('option',{value:'center',text:'居中'}),h('option',{value:'right',text:'右对齐'}))),
    h('div',{class:'prop-sub'},h('label',{},h('input',{type:'checkbox','data-key':'strokeOn'}),'描边'),h('input',{type:'color','data-key':'stroke','aria-label':'描边颜色'}),field('粗细',num('strokeWidth',{min:0,max:100}))),
    h('div',{class:'prop-sub'},h('label',{},h('input',{type:'checkbox','data-key':'shadowOn'}),'阴影'),h('input',{type:'color','data-key':'shadowColor','aria-label':'阴影颜色'}),
     field('模糊',num('shadowBlur',{min:0,max:200})),field('偏移',num('shadowOffset',{min:-200,max:200}))));
  }else if(k==='shape'){
   box.append(field('填充',colorInput('fill')),
    h('div',{class:'prop-sub'},h('label',{},h('input',{type:'checkbox','data-key':'strokeOn'}),'描边'),h('input',{type:'color','data-key':'stroke','aria-label':'描边颜色'}),field('粗细',num('strokeWidth',{min:0,max:200}))));
   if(obj.pe.shape==='roundrect')box.append(field('圆角',num('rx',{min:0})));
  }else{
   box.append(h('p',{class:'prop-note','data-key':'imageNote'}));
  }
  box.oninput=e=>apply(e.target,false);
  box.onchange=e=>apply(e.target,true);
  box.onclick=e=>{const sw=e.target.closest('.swatch');if(sw){const input=sw.closest('.prop-color').querySelector('input[type=color]');input.value=sw.dataset.color;apply(input,true);}};
  syncProps(obj);
 }
 const toHex=c=>{if(typeof c!=='string')return '#000000';if(/^#[0-9a-f]{6}$/i.test(c))return c;if(/^#[0-9a-f]{3}$/i.test(c))return '#'+[...c.slice(1)].map(x=>x+x).join('');const m=c.match(/\d+/g);return m&&m.length>=3?'#'+m.slice(0,3).map(v=>Number(v).toString(16).padStart(2,'0')).join(''):'#000000';};
 function syncProps(obj){
  const box=$('props');if(!obj||box.hidden)return;
  const r=obj.getBoundingRect(),s=obj.shadow,natural=E.imageInfo(obj);
  const values={x:Math.round(r.left),y:Math.round(r.top),w:Math.round(obj.getScaledWidth()),h:Math.round(obj.getScaledHeight()),
   angle:Math.round(obj.angle),opacity:Math.round(obj.opacity*100),text:obj.text,fontName:obj.pe.fontName,fontSize:Math.round(obj.fontSize||0),
   lineHeight:obj.lineHeight,charSpacing:obj.charSpacing,fill:toHex(obj.fill),bold:obj.fontWeight==='bold',italic:obj.fontStyle==='italic',
   textAlign:obj.textAlign,strokeOn:obj.strokeWidth>0,stroke:toHex(obj.stroke||'#ffffff'),strokeWidth:obj.strokeWidth,
   shadowOn:!!s,shadowColor:toHex(s?.color||'#000000'),shadowBlur:s?.blur??8,shadowOffset:s?.offsetY??4,rx:Math.round(obj.rx||0)};
  for(const input of box.querySelectorAll('[data-key]')){
   const key=input.dataset.key;if(input===document.activeElement||values[key]===undefined)continue;
   if(input.type==='checkbox')input.checked=!!values[key];else input.value=values[key];
  }
  const h_=box.querySelector('[data-key=h]');if(h_)h_.disabled=obj.pe.kind==='text';
  const note=box.querySelector('[data-key=imageNote]');
  if(note&&natural){
   const up=C.upscale(obj);
   note.textContent=`原图 ${natural.w} × ${natural.h} px · 当前 ${Math.round(up*100)}%`+(up>1.5?'。放大过多可能模糊，二维码可能扫不出。':'');
   note.classList.toggle('warn',up>1.5);
  }
  for(const input of box.querySelectorAll('input,select,textarea'))input.disabled=!!obj.pe.locked||busy()||(input.dataset.key==='h'&&obj.pe.kind==='text');
 }
 function apply(input,record){
  const obj=E.selected();const key=input.dataset.key;if(!obj||!key)return;
  const id=obj.pe.id,v=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;
  if(input.type==='number'&&!Number.isFinite(v))return;
  const r=obj.getBoundingRect(),keepRatio=obj.pe.kind==='image'||obj.pe.kind==='split';
  const props={};
  switch(key){
   case 'x':props.left=obj.left+v-r.left;break;
   case 'y':props.top=obj.top+v-r.top;break;
   case 'w':if(v<1)return;if(obj.pe.kind==='text')props.width=v/obj.scaleX;else{const f=v/obj.getScaledWidth();props.scaleX=obj.scaleX*f;if(keepRatio)props.scaleY=obj.scaleY*f;}break;
   case 'h':if(v<1)return;{const f=v/obj.getScaledHeight();props.scaleY=obj.scaleY*f;if(keepRatio)props.scaleX=obj.scaleX*f;}break;
   case 'angle':props.angle=v;break;
   case 'opacity':props.opacity=Math.max(0,Math.min(100,v))/100;break;
   case 'bold':props.fontWeight=v?'bold':'normal';break;
   case 'italic':props.fontStyle=v?'italic':'normal';break;
   case 'strokeOn':props.strokeWidth=v?Math.max(2,Math.round((obj.fontSize||40)/20)):0;props.stroke=v?($('props').querySelector('[data-key=stroke]').value):null;break;
   case 'stroke':props.stroke=v;if(!obj.strokeWidth)props.strokeWidth=2;break;
   case 'strokeWidth':props.strokeWidth=Math.max(0,v);if(v>0&&!obj.stroke)props.stroke=$('props').querySelector('[data-key=stroke]').value;break;
   case 'shadowOn':case 'shadowColor':case 'shadowBlur':case 'shadowOffset':{
    const box=$('props'),get=k=>box.querySelector(`[data-key=${k}]`);
    const on=key==='shadowOn'?v:get('shadowOn').checked||key!=='shadowOn';
    if(key!=='shadowOn')get('shadowOn').checked=true;
    const offset=Number(get('shadowOffset').value)||0;
    props.shadow=on?new fabric.Shadow({color:get('shadowColor').value,blur:Number(get('shadowBlur').value)||0,offsetX:Math.round(offset/2),offsetY:offset}):null;break;}
   default:props[key]=v;
  }
  E.update(id,props,{record});
 }

 /* ---------- toolbar ---------- */
 function refresh(){
  const open=E.isOpen(),b=busy();
  $('editor-toolbar').hidden=!open;
  if(!open){$('props').hidden=true;propsFor=null;return;}
  renderList();
  $('undo').disabled=b||!E.canUndo();$('redo').disabled=b||!E.canRedo();
  const obj=E.selected();
  $('reset-layer').disabled=b||!obj||obj.pe.kind!=='split';
  $('select-all').disabled=b||E.objects().every(o=>o.visible);
  onSelection(obj);
 }
 function onSelection(obj){
  if(!E.isOpen())return;
  if((obj?.pe.id||null)!==propsFor)buildProps(obj);else syncProps(obj);
  $('selected-layer').textContent=obj?`已选中：${obj.pe.name||KIND_LABEL[obj.pe.kind]}`:'点击画面里的元素选中';
  $('layer-position').textContent=obj?`${KIND_LABEL[obj.pe.kind]} · X ${Math.round(obj.getBoundingRect().left)} / Y ${Math.round(obj.getBoundingRect().top)}`:'';
  $('reset-layer').disabled=busy()||!obj||obj.pe.kind!=='split';
  for(const r of $('layer-list').children)r.classList.toggle('selected',r.dataset.id===obj?.pe.id);
 }
 function init(options){
  opts=options;checkFonts();
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
