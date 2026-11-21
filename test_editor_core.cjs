// Pure editor logic: export layout, document normalisation, snapping, history, migration.
const assert=require('node:assert/strict');
const C=require('./static/editor-core.js');
const near=(a,b,e=1e-6)=>Math.abs(a-b)<=e;

// test_canvas_layout_original_size
assert.deepEqual(C.canvasLayout(400,500,'auto'),{width:400,height:500,scale:1,offsetX:0,offsetY:0});
// test_canvas_layout_standard_ratios_keep_whole_picture
for(const [ratio,size] of Object.entries({'1:1':[1600,1600],'9:16':[1080,1920],'16:9':[1920,1080],'5:2':[1500,600],'4:3':[1600,1200],'3:4':[1200,1600]})){
 const l=C.canvasLayout(400,500,ratio);
 assert.deepEqual([l.width,l.height],size);
 assert.ok(l.offsetX>=-1e-9&&l.offsetY>=-1e-9,`${ratio} 完整保留原图`);
}
// test_canvas_layout_near_ratio_fills
{
 const l=C.canvasLayout(896,1156,'3:4');
 assert.ok(l.offsetX<=1e-6&&l.offsetY<=1e-6,'比例接近时铺满');
 assert.ok(l.offsetX+896*l.scale>=1200-1e-6&&l.offsetY+1156*l.scale>=1600-1e-6);
 const far=C.canvasLayout(896,1156,'16:9');
 assert.ok(far.offsetX>=0&&far.offsetY>=-1e-9&&896*far.scale<=1920+1e-9,'相差大时留白');
}
console.log('导出比例：原图尺寸、六种比例、接近铺满、相差留白检查通过');

// test_fonts
assert.ok(C.FONTS.length===6&&C.FONTS[0].name==='微软雅黑');
assert.match(C.fontCss('楷体'),/KaiTi/);
assert.equal(C.fontCss('不存在的字体'),C.FONTS[0].css);

// test_normalize_doc
{
 const raw={version:1,size:{width:896,height:1156},outputRatio:'3:4',extra:1,objects:[
  {id:'a',kind:'split',name:'背景',source:'layer-08.png',left:448,top:578,scaleX:1,scaleY:1,angle:0,opacity:1,visible:true,locked:true,evil:'x'},
  {id:'b',kind:'text',name:'标题',text:'报名',left:'10',top:NaN,fontFamily:'楷体',fontSize:9999,fill:'#ff0000',fontWeight:'heavy',textAlign:'justify',width:300,shadow:{color:'#000',blur:4,offsetX:2,offsetY:2},stroke:'#fff',strokeWidth:2},
  {id:'c',kind:'shape',shape:'roundrect',width:200,height:80,rx:16,fill:'#ffffffcc',left:10,top:10},
  {id:'d',kind:'script',left:0,top:0},
  {id:'e',kind:'image',source:'../secret.png',left:0,top:0},
  {id:'f',kind:'image',source:'edit/upload-ab12.png',left:5,top:5,opacity:7},
 ]};
 const d=C.normalizeDoc(raw);
 assert.equal(d.outputRatio,'3:4');assert.ok(!('extra' in d));
 assert.deepEqual(d.objects.map(o=>o.id),['a','b','c','f'],'未知类型和非法路径被丢弃');
 assert.ok(!('evil' in d.objects[0]));
 const t=d.objects[1];
 assert.equal(t.left,0,'非数字回退为 0');assert.equal(t.top,0);
 assert.equal(t.fontSize,1000,'字号上限');assert.equal(t.fontWeight,'normal');assert.equal(t.textAlign,'left');
 assert.equal(t.fontFamily,'楷体');assert.deepEqual(t.shadow,{color:'#000',blur:4,offsetX:2,offsetY:2});
 assert.equal(d.objects[3].opacity,1,'不透明度钳到 0–1');
 assert.equal(d.objects[2].shape,'roundrect');
 assert.throws(()=>C.normalizeDoc({version:2,objects:[]}),/版本/);
 assert.equal(C.normalizeDoc({version:1,size:{width:10,height:10},objects:Array.from({length:300},(_,i)=>({id:'x'+i,kind:'shape',shape:'rect'}))}).objects.length,200);
 assert.equal(C.normalizeDoc({version:1,size:{width:10,height:10},objects:[{id:'t',kind:'text',text:'字'.repeat(3000)}]}).objects[0].text.length,2000);
}
console.log('编辑稿规整：未知字段、非法路径、数值钳制、数量与长度上限检查通过');

// test_snap
{
 const targets=C.snapTargets({width:1000,height:800},[{left:100,top:100,width:200,height:100}]);
 assert.ok(targets.x.includes(500)&&targets.x.includes(0)&&targets.x.includes(1000)&&targets.x.includes(300));
 assert.ok(targets.y.includes(400)&&targets.y.includes(150));
 // centre 497 → 500
 const s=C.snapMove({left:447,top:600,width:100,height:50},targets,6);
 assert.equal(s.dx,3);assert.equal(s.dy,0);assert.deepEqual(s.guides,[{axis:'x',pos:500}]);
 // left edge 302 → 300 (another box's right edge), top 152-? none
 const e=C.snapMove({left:302,top:146,width:50,height:10},targets,6);
 assert.equal(e.dx,-2);assert.equal(e.dy,-1,'中心 151 → 150');
 assert.deepEqual(C.snapMove({left:420,top:620,width:20,height:20},targets,6),{dx:0,dy:0,guides:[]},'阈值外不吸附');
 assert.deepEqual(C.snapMove({left:447,top:600,width:100,height:50},targets,0),{dx:0,dy:0,guides:[]},'阈值 0（按住 Alt）关闭吸附');
}
console.log('对齐吸附：中线、边缘、对象边、阈值与关闭检查通过');

// test_history
{
 const h=new C.History(3);
 assert.equal(h.canUndo(),false);
 h.reset('s0');h.push('s1');h.push('s1');h.push('s2');
 assert.equal(h.undo(),'s1');assert.equal(h.undo(),'s0');assert.equal(h.undo(),null);
 assert.equal(h.redo(),'s1');
 h.push('s3');assert.equal(h.canRedo(),false,'新操作丢弃重做分支');
 h.push('s4');h.push('s5');h.push('s6');
 let n=0;while(h.undo()!==null)n++;assert.equal(n,3,'上限 3 步');
}
console.log('撤销栈：去重、上限、重做分支检查通过');

// test_compact_and_upscale
assert.equal(C.isCompact({x:0,y:0,width:100,height:100},1000,1000),true);
assert.equal(C.isCompact({x:0,y:0,width:900,height:900},1000,1000),false);
assert.equal(C.isCompact(null,10,10),false);
assert.ok(near(C.upscale({scaleX:2,scaleY:1.5}),2));

// test_scale_objects
{
 const moved=C.scaleObjects([{id:'t',kind:'text',left:100,top:200,scaleX:1,scaleY:1,fontSize:40}],0.5);
 assert.deepEqual([moved[0].left,moved[0].top,moved[0].scaleX,moved[0].scaleY,moved[0].fontSize],[50,100,0.5,0.5,40]);
}
console.log('拆层迁移换算、紧凑图层判断、放大倍数检查通过');
