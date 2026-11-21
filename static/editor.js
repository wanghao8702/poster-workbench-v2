'use strict';
// Fabric.js poster editor for the 「03 编辑导出」 stage. Scene coordinates are the source image's pixels; the
// edit document (see docs/接口文档.md) is the only persisted state, so undo, save and reload all go through it.
const PosterEditor=(()=>{
 const C=EditorCore;
 const SNAP_PX=6,ADDED_KINDS=['image','text','shape'];
 let canvas=null,host=null,opts={},scene={width:1,height:1},zoom=1;
 let assetId=null,baseUrl='/',sample=false,openFlag=false,outputRatio='auto';
 let history=new C.History(50),guides=[],clipboard=null,memSeq=0,applying=false;
 const images=new Map();      // url -> {el, bounds, coverage, w, h}
 const memory=new Map();      // 'mem:N' -> data URL, for edits that are never saved (the sample)
 let idSeq=0;
 const newId=()=>`o${Date.now().toString(36)}${(idSeq++).toString(36)}`;

 /* ---------- images ---------- */
 const urlOf=source=>source.startsWith('mem:')?memory.get(source):baseUrl+source.split('/').map(encodeURIComponent).join('/');
 function analyze(el){
  const c=document.createElement('canvas');c.width=el.naturalWidth;c.height=el.naturalHeight;
  const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(el,0,0);
  const px=ctx.getImageData(0,0,c.width,c.height).data;
  let minX=c.width,minY=c.height,maxX=-1,maxY=-1,filled=0;
  for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(px[(y*c.width+x)*4+3]>12){filled++;if(x<minX)minX=x;if(y<minY)minY=y;if(x>maxX)maxX=x;if(y>maxY)maxY=y;}
  return {bounds:maxX<0?null:{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1},coverage:filled/(c.width*c.height)};
 }
 async function loadImage(url){
  if(images.has(url))return images.get(url);
  const el=new Image();el.src=url;await el.decode();
  const info={el,w:el.naturalWidth,h:el.naturalHeight,...analyze(el)};
  images.set(url,info);return info;
 }

 /* ---------- objects <-> document ---------- */
 const CONTROL={originX:'center',originY:'center',borderColor:'#2443e5',cornerColor:'#ffffff',cornerStrokeColor:'#2443e5',
  cornerStyle:'rect',cornerSize:10,transparentCorners:false,borderScaleFactor:1.5,padding:0};
 function applyLock(obj){
  const locked=!!obj.pe.locked;
  obj.set({selectable:!locked,evented:!locked,hasControls:!locked,lockMovementX:locked,lockMovementY:locked,
   lockScalingX:locked,lockScalingY:locked,lockRotation:locked,hoverCursor:locked?'default':'move'});
 }
 async function build(o){
  let obj;
  if(o.kind==='split'||o.kind==='image'){
   const info=await loadImage(urlOf(o.source));
   const b=info.bounds||{x:0,y:0,width:info.w,height:info.h};
   obj=new fabric.FabricImage(info.el,{cropX:b.x,cropY:b.y,width:b.width,height:b.height,
    perPixelTargetFind:!C.isCompact(info.bounds,info.w,info.h)});
   obj.pe={home:{left:b.x+b.width/2,top:b.y+b.height/2},natural:{w:b.width,h:b.height}};
  }else if(o.kind==='text'){
   obj=new fabric.Textbox(o.text,{fontFamily:C.fontCss(o.fontFamily),fontSize:o.fontSize,fill:o.fill,fontWeight:o.fontWeight,
    fontStyle:o.fontStyle,textAlign:o.textAlign,lineHeight:o.lineHeight,charSpacing:o.charSpacing,width:o.width,
    stroke:o.stroke,strokeWidth:o.stroke?o.strokeWidth:0,paintFirst:'stroke',splitByGrapheme:true,
    shadow:o.shadow?new fabric.Shadow(o.shadow):null});
   obj.pe={fontName:o.fontFamily};
  }else{
   const r=o.shape==='roundrect'?o.rx:0;
   obj=new fabric.Rect({width:o.width,height:o.height,rx:r,ry:r,fill:o.fill,stroke:o.stroke,strokeWidth:o.stroke?o.strokeWidth:0,strokeUniform:true});
   obj.pe={shape:o.shape};
  }
  Object.assign(obj.pe,{id:o.id,kind:o.kind,name:o.name,source:o.source,locked:o.locked});
  obj.set({...CONTROL,left:o.left,top:o.top,scaleX:o.scaleX,scaleY:o.scaleY,angle:o.angle,opacity:o.opacity,visible:o.visible});
  applyLock(obj);obj.setCoords();
  return obj;
 }
 function describe(obj){
  const p=obj.pe;
  const o={id:p.id,kind:p.kind,name:p.name||'',left:obj.left,top:obj.top,scaleX:obj.scaleX,scaleY:obj.scaleY,angle:obj.angle,
   opacity:obj.opacity,visible:obj.visible,locked:!!p.locked};
  if(p.kind==='split'||p.kind==='image')o.source=p.source;
  else if(p.kind==='text'){
   const s=obj.shadow;
   Object.assign(o,{text:obj.text,fontFamily:p.fontName,fontSize:obj.fontSize,fill:obj.fill,fontWeight:obj.fontWeight==='bold'?'bold':'normal',
    fontStyle:obj.fontStyle==='italic'?'italic':'normal',textAlign:obj.textAlign,lineHeight:obj.lineHeight,charSpacing:obj.charSpacing,
    width:obj.width,stroke:obj.strokeWidth>0?obj.stroke:null,strokeWidth:obj.strokeWidth,
    shadow:s?{color:s.color,blur:s.blur,offsetX:s.offsetX,offsetY:s.offsetY}:null});
  }else Object.assign(o,{shape:p.shape,width:obj.width,height:obj.height,rx:obj.rx||0,fill:obj.fill,
   stroke:obj.strokeWidth>0?obj.stroke:null,strokeWidth:obj.strokeWidth});
  return o;
 }
 const objects=()=>canvas?canvas.getObjects().filter(o=>o.pe):[];
 function toDoc(){return {version:1,size:{...scene},outputRatio,objects:objects().map(describe)};}
 const find=id=>objects().find(o=>o.pe.id===id)||null;

 /* ---------- change tracking ---------- */
 function commit(){
  if(applying||!openFlag)return;
  const doc=toDoc();history.push(JSON.stringify(doc));
  opts.onChange?.(doc);opts.onLayers?.();
 }
 async function applyDoc(doc,keepId){
  applying=true;
  try{
   const built=[];let missing=0;
   for(const o of doc.objects){try{built.push(await build(o));}catch(e){missing++;}}
   canvas.discardActiveObject();canvas.remove(...canvas.getObjects());canvas.add(...built);
   outputRatio=doc.outputRatio||'auto';
   const again=keepId&&find(keepId);if(again&&again.selectable)canvas.setActiveObject(again);
   canvas.requestRenderAll();return missing;
  }finally{applying=false;}
 }

 /* ---------- opening ---------- */
 // layers: [{source, label}] with the topmost layer first, the way the model returns them.
 async function open(params){
  assetId=params.assetId||null;baseUrl=params.baseUrl||'/';sample=!!params.sample;memory.clear();
  const infos=await Promise.all(params.layers.map(l=>loadImage(urlOf(l.source))));
  scene={width:infos[0].w,height:infos[0].h};
  let doc=null,missing=0;
  if(params.doc){
   try{doc=C.normalizeDoc(params.doc);}catch(e){opts.notify?.('编辑稿无法读取，已按原始图层打开。',true);}
  }
  if(!doc){
   // A layer that fills the canvas is the backdrop: keep it at the bottom and lock it against stray drags.
   const order=params.layers.map((l,i)=>({l,info:infos[i]})).sort((a,b)=>Number(a.info.coverage>0.85)-Number(b.info.coverage>0.85));
   doc={version:1,size:{...scene},outputRatio:'auto',objects:order.reverse().map(({l,info})=>{
    const b=info.bounds||{x:0,y:0,width:info.w,height:info.h};
    return {id:newId(),kind:'split',name:l.label,source:l.source,left:b.x+b.width/2,top:b.y+b.height/2,scaleX:1,scaleY:1,angle:0,
     opacity:1,visible:!!info.bounds,locked:info.coverage>0.85};
   })};
  }
  openFlag=true;host.hidden=false;
  missing=await applyDoc(doc);
  history.reset(JSON.stringify(toDoc()));
  fit();opts.onLayers?.();opts.onSelection?.(null);
  if(missing)opts.notify?.(`有 ${missing} 个图层的文件找不到，已跳过。`,true);
  return toDoc();
 }
 function close(){
  if(!canvas)return;
  openFlag=false;canvas.discardActiveObject();canvas.remove(...canvas.getObjects());history.reset(null);
  host.hidden=true;opts.onLayers?.();opts.onSelection?.(null);
 }

 /* ---------- display ---------- */
 function fit(){
  if(!openFlag)return;
  const stage=opts.stage,margin=stage.clientWidth<600?14:32;
  zoom=Math.max(0.05,Math.min((stage.clientWidth-margin*2)/scene.width,(stage.clientHeight-margin*2)/scene.height,2));
  canvas.setDimensions({width:Math.max(1,Math.floor(scene.width*zoom)),height:Math.max(1,Math.floor(scene.height*zoom))});
  canvas.setZoom(zoom);canvas.requestRenderAll();
 }
 // Guides and the export-crop shade are drawn on the visible canvas only, never into exports.
 function drawOverlay(ctx){
  const vpt=canvas.viewportTransform;
  ctx.save();ctx.transform(vpt[0],vpt[1],vpt[2],vpt[3],vpt[4],vpt[5]);
  if(outputRatio!=='auto'){
   const l=C.canvasLayout(scene.width,scene.height,outputRatio);
   const x=Math.max(0,-l.offsetX/l.scale),y=Math.max(0,-l.offsetY/l.scale);
   const w=Math.min(scene.width,l.width/l.scale),h=Math.min(scene.height,l.height/l.scale);
   if(x>0.5||y>0.5){
    ctx.fillStyle='rgba(21,23,28,0.35)';
    ctx.fillRect(0,0,scene.width,y);ctx.fillRect(0,y+h,scene.width,scene.height-y-h);
    ctx.fillRect(0,y,x,h);ctx.fillRect(x+w,y,scene.width-x-w,h);
   }
  }
  ctx.strokeStyle='#2443e5';ctx.lineWidth=1/zoom;ctx.setLineDash([4/zoom,3/zoom]);
  for(const g of guides){ctx.beginPath();if(g.axis==='x'){ctx.moveTo(g.pos,0);ctx.lineTo(g.pos,scene.height);}else{ctx.moveTo(0,g.pos);ctx.lineTo(scene.width,g.pos);}ctx.stroke();}
  ctx.restore();
 }

 /* ---------- snapping ---------- */
 function box(obj){const r=obj.getBoundingRect();return {left:r.left,top:r.top,width:r.width,height:r.height};}
 function snap(event){
  const obj=event.target;
  if(event.e?.altKey){guides=[];return;}
  obj.setCoords(); // Fabric does not refresh the bounding box while dragging; snap from where the object is now

  const skip=new Set(obj.type==='activeselection'?obj.getObjects():[obj]);
  const others=objects().filter(o=>o.visible&&!skip.has(o)).map(box);
  const s=C.snapMove(box(obj),C.snapTargets(scene,others),SNAP_PX/zoom);
  if(s.dx||s.dy){obj.set({left:obj.left+s.dx,top:obj.top+s.dy});obj.setCoords();}
  guides=s.guides;
 }

 /* ---------- adding ---------- */
 function place(obj){
  const active=canvas.getActiveObject();
  const all=canvas.getObjects();
  const at=active&&active.pe?all.indexOf(active)+1:all.length;
  canvas.insertAt(at,obj);canvas.setActiveObject(obj);canvas.requestRenderAll();commit();
 }
 async function readFile(file){
  if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  if(file.size>20*1024*1024)throw new Error('图片不能超过 20 MB。');
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('图片无法读取。'));r.readAsDataURL(file);});
 }
 async function addImage(file){
  if(!openFlag)return;
  const data=await readFile(file);
  // Saved records keep the file on disk; the sample keeps it in memory only.
  const stored=!sample&&opts.uploader?await opts.uploader(data):null;
  let source=stored?.source;
  if(!source){source=`mem:${++memSeq}`;memory.set(source,data);}
  const info=await loadImage(urlOf(source));
  const b=info.bounds||{width:info.w,height:info.h};
  const s=Math.min(1,scene.width*0.4/b.width,scene.height*0.4/b.height);
  const name=(file.name||'图片').replace(/\.[^.]*$/,'').slice(0,30)||'图片';
  place(await build({id:newId(),kind:'image',name,source,left:scene.width/2,top:scene.height/2,scaleX:s,scaleY:s,angle:0,opacity:1,visible:true,locked:false}));
 }
 async function addText(){
  if(!openFlag)return;
  const size=Math.max(24,Math.round(scene.height*0.045));
  const obj=await build({id:newId(),kind:'text',name:'文字',text:'双击编辑文字',left:scene.width/2,top:scene.height/2,scaleX:1,scaleY:1,angle:0,
   opacity:1,visible:true,locked:false,fontFamily:C.FONTS[0].name,fontSize:size,fill:'#15171c',fontWeight:'bold',fontStyle:'normal',
   textAlign:'center',lineHeight:1.2,charSpacing:0,width:Math.round(scene.width*0.6),stroke:null,strokeWidth:0,shadow:null});
  place(obj);obj.enterEditing();obj.selectAll();
 }
 async function addShape(shape){
  if(!openFlag)return;
  const line=shape==='line';
  const w=Math.round(scene.width*(line?0.5:0.6)),h=line?Math.max(4,Math.round(scene.height*0.004)):Math.round(scene.height*0.12);
  place(await build({id:newId(),kind:'shape',name:{rect:'矩形',roundrect:'圆角矩形',line:'线条'}[shape]||'形状',shape,
   left:scene.width/2,top:scene.height/2,scaleX:1,scaleY:1,angle:0,opacity:line?1:0.85,visible:true,locked:false,
   width:w,height:h,rx:shape==='roundrect'?Math.round(h*0.25):0,fill:line?'#15171c':'#ffffff',stroke:null,strokeWidth:0}));
 }

 /* ---------- object commands (used by the panel and the keyboard) ---------- */
 function select(id){
  const obj=find(id);if(!obj){canvas.discardActiveObject();canvas.requestRenderAll();return;}
  if(!obj.visible)return;
  canvas.setActiveObject(obj);canvas.requestRenderAll();opts.onSelection?.(obj);
 }
 function selected(){const a=canvas?.getActiveObject();return a&&a.pe?a:null;}
 function update(id,props,{record=true}={}){
  const obj=find(id);if(!obj)return;
  if('locked' in props){obj.pe.locked=props.locked;applyLock(obj);if(props.locked&&canvas.getActiveObject()===obj)canvas.discardActiveObject();}
  if('name' in props)obj.pe.name=props.name;
  if('fontName' in props){obj.pe.fontName=props.fontName;obj.set('fontFamily',C.fontCss(props.fontName));}
  const rest={...props};delete rest.locked;delete rest.name;delete rest.fontName;
  if('rx' in rest)rest.ry=rest.rx;
  if('visible' in rest&&!rest.visible&&canvas.getActiveObject()===obj)canvas.discardActiveObject();
  obj.set(rest);obj.setCoords();
  if(obj.type==='textbox'&&('text' in rest||'fontSize' in rest||'width' in rest))obj.initDimensions?.();
  canvas.requestRenderAll();
  if(record)commit();else opts.onSelection?.(selected());
 }
 function reorder(id,target){
  const obj=find(id);if(!obj)return;
  const all=canvas.getObjects(),i=all.indexOf(obj);
  const to=target==='top'?all.length-1:target==='bottom'?0:typeof target==='number'?target:i+(target==='up'?1:-1);
  if(to<0||to>=all.length||to===i)return;
  canvas.moveObjectTo(obj,to);canvas.requestRenderAll();commit();
 }
 async function duplicate(id){
  const obj=find(id);if(!obj)return;
  const o={...describe(obj),id:newId(),name:`${obj.pe.name||'图层'} 副本`,left:obj.left+20,top:obj.top+20,locked:false,visible:true};
  if(o.kind==='split')o.kind='image';
  const copy=await build(o);
  const all=canvas.getObjects();canvas.insertAt(all.indexOf(obj)+1,copy);canvas.setActiveObject(copy);canvas.requestRenderAll();commit();
 }
 // Model output is never thrown away: split layers can only be hidden; everything the user added can be deleted.
 function remove(id){
  const obj=find(id);if(!obj)return;
  if(obj.pe.kind==='split'){update(id,{visible:false});opts.notify?.(`已隐藏「${obj.pe.name}」，可在右侧图层列表恢复，或按 Ctrl+Z 撤销。`);return;}
  canvas.remove(obj);canvas.requestRenderAll();commit();
 }
 function reset(id){
  const obj=find(id);if(!obj||obj.pe.kind!=='split')return;
  update(id,{left:obj.pe.home.left,top:obj.pe.home.top,scaleX:1,scaleY:1,angle:0});
 }
 function resetAll(){
  applying=true;
  for(const obj of objects())if(obj.pe.kind==='split'){obj.set({left:obj.pe.home.left,top:obj.pe.home.top,scaleX:1,scaleY:1,angle:0});obj.setCoords();}
  applying=false;canvas.requestRenderAll();commit();
 }
 function showAll(){applying=true;for(const obj of objects())obj.set('visible',true);applying=false;canvas.requestRenderAll();commit();}
 function reverse(){
  applying=true;const all=[...canvas.getObjects()].reverse();all.forEach((o,i)=>canvas.moveObjectTo(o,i));applying=false;
  canvas.requestRenderAll();commit();
 }
 // Objects carried over from another record (already rescaled), stacked on top.
 async function addObjects(list){
  let skipped=0;applying=true;
  try{for(const o of list){try{canvas.add(await build({...o,id:newId()}));}catch(e){skipped++;}}}finally{applying=false;}
  canvas.requestRenderAll();commit();return skipped;
 }
 async function undo(){const s=history.undo();if(s)await restoreState(s);}
 async function redo(){const s=history.redo();if(s)await restoreState(s);}
 async function restoreState(json){
  const keep=selected()?.pe.id;await applyDoc(JSON.parse(json),keep);
  opts.onChange?.(toDoc());opts.onLayers?.();opts.onSelection?.(selected());
 }
 function setOutputRatio(ratio){outputRatio=ratio;canvas?.requestRenderAll();commit();}

 /* ---------- export ---------- */
 function render(selection){
  // Draw objects only: controls, guides and the crop shade belong to the screen, not the file.
  const active=canvas.getActiveObject();
  if(active?.isEditing)active.exitEditing();
  canvas.discardActiveObject();guides=[];canvas.renderAll();
  const out=canvas.toCanvasElement(scene.width/canvas.getWidth(),{left:0,top:0,width:canvas.getWidth(),height:canvas.getHeight()});
  if(selection&&active&&active.selectable)canvas.setActiveObject(active);
  canvas.requestRenderAll();return out;
 }
 async function exportCanvas(){
  await document.fonts?.ready;
  const src=render(true);
  const l=C.canvasLayout(scene.width,scene.height,outputRatio);
  const out=document.createElement('canvas');out.width=l.width;out.height=l.height;
  const ctx=out.getContext('2d');
  if(outputRatio!=='auto'){ctx.fillStyle='#f8f7f1';ctx.fillRect(0,0,l.width,l.height);}
  ctx.drawImage(src,l.offsetX,l.offsetY,scene.width*l.scale,scene.height*l.scale);
  return out;
 }
 async function objectBlob(id){
  const obj=find(id);if(!obj)return null;
  const c=obj.toCanvasElement({multiplier:1,enableRetinaScaling:false});
  return new Promise(resolve=>c.toBlob(resolve,'image/png'));
 }
 function thumbnail(obj,size){
  try{return obj.toCanvasElement({multiplier:Math.min(1,size/Math.max(obj.getScaledWidth(),obj.getScaledHeight(),1)),enableRetinaScaling:false});}
  catch(e){return null;}
 }

 /* ---------- keyboard ---------- */
 function onKey(event){
  if(!openFlag||opts.isBlocked?.()||event.target.closest?.('input,textarea,select,[role=tab],dialog'))return;
  const active=canvas.getActiveObject();
  if(active?.isEditing)return;
  const command=event.metaKey||event.ctrlKey,key=event.key.toLowerCase();
  if(command&&key==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
  if(command&&key==='y'){event.preventDefault();redo();return;}
  const obj=selected();
  if(command&&key==='c'&&obj){clipboard=obj.pe.id;return;}
  if(command&&key==='v'&&clipboard&&find(clipboard)){event.preventDefault();duplicate(clipboard);return;}
  if(command&&key==='d'&&obj){event.preventDefault();duplicate(obj.pe.id);return;}
  if(command||event.altKey)return;
  if(event.key==='Escape'){canvas.discardActiveObject();canvas.requestRenderAll();return;}
  if(!obj)return;
  const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]},d=moves[event.key];
  if(d){
   event.preventDefault();const step=event.shiftKey?10:1;
   obj.set({left:obj.left+d[0]*step,top:obj.top+d[1]*step});obj.setCoords();canvas.requestRenderAll();
   // Record once per key press, not on every auto-repeat.
   clearTimeout(onKey.timer);onKey.timer=setTimeout(commit,250);opts.onSelection?.(obj);
  }else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();remove(obj.pe.id);}
 }

 /* ---------- setup ---------- */
 function init(options){
  opts=options;host=options.host;
  canvas=new fabric.Canvas(options.canvasEl,{preserveObjectStacking:true,targetFindTolerance:4,fireRightClick:true,stopContextMenu:true,
   selectionColor:'rgba(36,67,229,0.08)',selectionBorderColor:'#2443e5',selectionLineWidth:1,uniformScaling:true,uniScaleKey:null});
  canvas.on('object:moving',snap);
  canvas.on('object:rotating',e=>{if(e.e?.shiftKey){e.target.set('angle',Math.round(e.target.angle/15)*15);}});
  canvas.on('object:modified',()=>{guides=[];commit();opts.onSelection?.(selected());});
  canvas.on('mouse:up',()=>{if(guides.length){guides=[];canvas.requestRenderAll();}});
  canvas.on('after:render',e=>{if(e.ctx===canvas.contextContainer&&openFlag)drawOverlay(e.ctx);});
  for(const name of ['selection:created','selection:updated','selection:cleared'])canvas.on(name,()=>opts.onSelection?.(selected()));
  canvas.on('text:changed',()=>opts.onSelection?.(selected()));
  canvas.on('text:editing:exited',commit);
  canvas.on('mouse:down',e=>{
   if(e.e.button!==2)return;
   const target=e.target&&e.target.pe?e.target:null;
   if(target){canvas.setActiveObject(target);canvas.requestRenderAll();}
   opts.onContextMenu?.(target,e.e.clientX,e.e.clientY);
  });
  const upper=canvas.upperCanvasEl;
  upper.addEventListener('dragover',e=>{e.preventDefault();});
  upper.addEventListener('drop',e=>{e.preventDefault();const f=e.dataTransfer?.files?.[0];if(f)addImage(f).catch(err=>opts.notify?.(err.message,true));});
  document.addEventListener('paste',e=>{
   if(!openFlag||e.target.closest?.('input,textarea,dialog')||canvas.getActiveObject()?.isEditing)return;
   const f=[...(e.clipboardData?.files||[])].find(x=>x.type.startsWith('image/'));
   if(f){e.preventDefault();addImage(f).catch(err=>opts.notify?.(err.message,true));}
  });
  document.addEventListener('keydown',onKey);
 }

 return {init,open,close,fit,toDoc,addImage,addObjects,addText,addShape,select,selected,update,reorder,duplicate,remove,reset,resetAll,showAll,reverse,
  undo,redo,canUndo:()=>history.canUndo(),canRedo:()=>history.canRedo(),setOutputRatio,exportCanvas,objectBlob,thumbnail,
  objects,describe,isOpen:()=>openFlag,isSample:()=>sample,scene:()=>({...scene}),assetId:()=>assetId,ADDED_KINDS,
  backdrop:()=>objects()[0]?.getElement?.()||null,
  imageInfo:obj=>obj&&(obj.pe.kind==='image'||obj.pe.kind==='split')?obj.pe.natural:null};
})();
