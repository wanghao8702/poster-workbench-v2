'use strict';
// Pure helpers for the poster editor: no DOM, no Fabric, so Node can test them directly.
const EditorCore=(()=>{
 const OUTPUT_SIZES={'1:1':[1600,1600],'9:16':[1080,1920],'16:9':[1920,1080],'5:2':[1500,600],'4:3':[1600,1200],'3:4':[1200,1600]};
 // Models return only roughly the requested ratio (3:4 → 1140×1472). Within 6% we fill the canvas and trim
 // a sliver instead of leaving off-white edges; a clearly different ratio still keeps the whole picture.
 function canvasLayout(srcW,srcH,ratio){
  const [width,height]=OUTPUT_SIZES[ratio]||[srcW,srcH];
  const near=Math.abs((width/height)/(srcW/srcH)-1)<=0.06;
  const scale=(near?Math.max:Math.min)(width/srcW,height/srcH);
  return {width,height,scale,offsetX:(width-srcW*scale)/2,offsetY:(height-srcH*scale)/2};
 }

 const FONTS=[
  {name:'微软雅黑',css:'"Microsoft YaHei", "PingFang SC", sans-serif'},
  {name:'黑体',css:'SimHei, "Heiti SC", sans-serif'},
  {name:'等线',css:'DengXian, "PingFang SC", sans-serif'},
  {name:'宋体',css:'SimSun, "Songti SC", serif'},
  {name:'仿宋',css:'FangSong, STFangsong, serif'},
  {name:'楷体',css:'KaiTi, "Kaiti SC", serif'}
 ];
 const fontCss=name=>(FONTS.find(f=>f.name===name)||FONTS[0]).css;

 const KINDS=['split','image','text','shape'];
 const SHAPES=['rect','roundrect','line'];
 const RATIOS=['auto',...Object.keys(OUTPUT_SIZES)];
 const SOURCE=/^(?:edit\/)?[\w.-]{1,120}$/;
 const COLOR=/^#[0-9a-f]{3,8}$/i;
 const num=(v,min,max,fallback)=>typeof v==='number'&&Number.isFinite(v)?Math.min(max,Math.max(min,v)):fallback;
 const str=(v,max,fallback='')=>typeof v==='string'?v.slice(0,max):fallback;
 const pick=(v,list,fallback)=>list.includes(v)?v:fallback;
 const color=(v,fallback)=>typeof v==='string'&&COLOR.test(v)?v:fallback;
 const BIG=1e6;
 /* Keep only what the editor understands, with numbers clamped, so a damaged or hand-edited file cannot break it. */
 function normalizeDoc(raw){
  if(!raw||raw.version!==1)throw new Error('编辑稿版本不支持。');
  const size=raw.size||{};
  const doc={version:1,size:{width:num(size.width,1,20000,1),height:num(size.height,1,20000,1)},
   outputRatio:pick(raw.outputRatio,RATIOS,'auto'),objects:[]};
  for(const o of Array.isArray(raw.objects)?raw.objects:[]){
   if(doc.objects.length>=200)break;
   if(!o||typeof o!=='object'||!KINDS.includes(o.kind))continue;
   const base={id:str(o.id,40)||`o${doc.objects.length+1}`,kind:o.kind,name:str(o.name,40),
    left:num(o.left,-BIG,BIG,0),top:num(o.top,-BIG,BIG,0),scaleX:num(o.scaleX,0.01,100,1),scaleY:num(o.scaleY,0.01,100,1),
    angle:num(o.angle,-360,360,0),opacity:num(o.opacity,0,1,1),visible:o.visible!==false,locked:o.locked===true};
   if(o.kind==='split'||o.kind==='image'){
    if(typeof o.source!=='string'||!SOURCE.test(o.source)||o.source.includes('..'))continue;
    doc.objects.push({...base,source:o.source});
   }else if(o.kind==='text'){
    const shadow=o.shadow&&typeof o.shadow==='object'?{color:color(o.shadow.color,'#000000'),blur:num(o.shadow.blur,0,200,8),
     offsetX:num(o.shadow.offsetX,-500,500,0),offsetY:num(o.shadow.offsetY,-500,500,4)}:null;
    doc.objects.push({...base,text:str(o.text,2000),fontFamily:FONTS.some(f=>f.name===o.fontFamily)?o.fontFamily:FONTS[0].name,
     fontSize:num(o.fontSize,4,1000,48),fill:color(o.fill,'#15171c'),fontWeight:pick(o.fontWeight,['normal','bold'],'normal'),
     fontStyle:pick(o.fontStyle,['normal','italic'],'normal'),textAlign:pick(o.textAlign,['left','center','right'],'left'),
     lineHeight:num(o.lineHeight,0.5,5,1.2),charSpacing:num(o.charSpacing,-500,2000,0),width:num(o.width,10,BIG,300),
     stroke:o.stroke?color(o.stroke,null):null,strokeWidth:num(o.strokeWidth,0,100,0),shadow});
   }else{
    doc.objects.push({...base,shape:pick(o.shape,SHAPES,'rect'),width:num(o.width,1,BIG,200),height:num(o.height,1,BIG,100),
     rx:num(o.rx,0,BIG,0),fill:color(o.fill,'#ffffff'),stroke:o.stroke?color(o.stroke,null):null,strokeWidth:num(o.strokeWidth,0,200,0)});
   }
  }
  return doc;
 }

 /* Lines an object may snap to: the canvas edges and centre, plus every other object's edges and centre. */
 function snapTargets(scene,boxes){
  const x=[0,scene.width/2,scene.width],y=[0,scene.height/2,scene.height];
  for(const b of boxes){x.push(b.left,b.left+b.width/2,b.left+b.width);y.push(b.top,b.top+b.height/2,b.top+b.height);}
  return {x,y};
 }
 function closest(edges,lines,threshold){
  let best=null;
  for(const e of edges)for(const l of lines){const d=l-e;if(Math.abs(d)<=threshold&&(!best||Math.abs(d)<Math.abs(best.d)))best={d,pos:l};}
  return best;
 }
 function snapMove(box,targets,threshold){
  if(!(threshold>0))return {dx:0,dy:0,guides:[]};
  const sx=closest([box.left,box.left+box.width/2,box.left+box.width],targets.x,threshold);
  const sy=closest([box.top,box.top+box.height/2,box.top+box.height],targets.y,threshold);
  const guides=[];if(sx)guides.push({axis:'x',pos:sx.pos});if(sy)guides.push({axis:'y',pos:sy.pos});
  return {dx:sx?sx.d:0,dy:sy?sy.d:0,guides};
 }

 class History{
  constructor(limit=50){this.limit=limit;this.past=[];this.future=[];this.current=null;}
  reset(state){this.past=[];this.future=[];this.current=state;}
  push(state){
   if(state===this.current)return;
   if(this.current!==null){this.past.push(this.current);if(this.past.length>this.limit)this.past.shift();}
   this.current=state;this.future=[];
  }
  undo(){if(!this.past.length)return null;this.future.push(this.current);this.current=this.past.pop();return this.current;}
  redo(){if(!this.future.length)return null;this.past.push(this.current);this.current=this.future.pop();return this.current;}
  canUndo(){return this.past.length>0;}
  canRedo(){return this.future.length>0;}
 }

 // Text is mostly gaps between strokes, so a compact layer can be grabbed anywhere inside its content box.
 const isCompact=(bounds,w,h)=>!!bounds&&bounds.width*bounds.height<0.35*w*h;
 const upscale=o=>Math.max(o.scaleX||1,o.scaleY||1);
 // Split output is smaller than the image it came from but has the same proportions: scale everything uniformly.
 const scaleObjects=(objects,ratio)=>objects.map(o=>({...o,left:o.left*ratio,top:o.top*ratio,scaleX:(o.scaleX||1)*ratio,scaleY:(o.scaleY||1)*ratio}));

 return {OUTPUT_SIZES,canvasLayout,FONTS,fontCss,KINDS,normalizeDoc,snapTargets,snapMove,History,isCompact,upscale,scaleObjects};
})();
if(typeof module!=='undefined')module.exports=EditorCore;
