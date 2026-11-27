// Front-end flow checks: run slices of static/app.js against a minimal fake DOM.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const TrainingPoster=require('./static/training-prompt.js');
const EditorCore=require('./static/editor-core.js');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
const slice=(from,to)=>{const i=source.indexOf(from),j=source.indexOf(to,i);assert.ok(i>=0&&j>i,`slice ${from}`);return source.slice(i,j);};

function element(value=''){return {value,hidden:false,textContent:'',href:'',focus(){},classList:{toggle(){}}};}
function sandbox(extra){
 const els={};
 const $=id=>els[id]||(els[id]=element());
 const ctx={$,els,TrainingPoster,OUTPUT_SIZES:{'1:1':1,'9:16':1,'16:9':1,'5:2':1,'4:3':1,'3:4':1},
  busy:false,sample:true,outputRatio:'auto',currentImage:null,notices:[],
  notify(m,e){ctx.notices.push([m,!!e]);},setBusy(){},setMode(){},closeLibrary(){},showControls(){},renderPrompt(){},
  loadSource:async(...a)=>{ctx.loaded=a;},openLayers:async o=>{ctx.opened=o;},orderedLayerItems:i=>i,pad2:n=>String(n).padStart(2,'0'),
  fetch:async url=>({ok:true,json:async()=>({version:1,objects:[],from:url})}),
  updateGenUI(){ctx.genUI=(ctx.genUI||0)+1;},
  document:{createElement:()=>({toDataURL:()=>'data:image/png;base64,'})},
  ...extra};
 vm.createContext(ctx);
 return ctx;
}

const plainLocal=v=>JSON.parse(JSON.stringify(v));
// test_open_asset_loads_history_prompt
(async()=>{
 const ctx=sandbox({purpose:'training',PROMPT_IDS:{cover:'cover-prompt',training:'generate-prompt',free:'free-prompt'},
  lastCompiled:{cover:null,training:{prompt:'表单拼出的提示词',ratio:'3:4',provider:'qwen',maxRefImages:3}},staleCategories:new Map()});
 vm.runInContext(slice('const STALE_SETTINGS=','function genSettings(')+'function promptEditor(){return $(PROMPT_IDS[purpose]);}'+slice('function assetFromItem(','$(\'open-library\').onclick'),ctx);
 await ctx.openAsset({kind:'generate',prompt:'【画布比例】3:4（宽:高）。\n历史提示词 肖像参考图“a.jpg”',ratio:'3:4',id:'x',images:[{name:'image-01.png',url:'/output/x/image-01.png'}]});
 assert.deepEqual(ctx.notices.filter(n=>n[1]),[],'载入历史素材不应报错');
 assert.equal(ctx.els['generate-prompt'].value,'历史提示词 肖像参考图“a.jpg”');
 assert.equal(ctx.loaded[0],'/output/x/image-01.png','没有编辑稿的生成图先显示原图');
 assert.deepEqual(plainLocal(ctx.loaded[2]),{id:'x',kind:'generate',baseUrl:'/output/x/',zip:null,title:'生成图片',layers:[{source:'image-01.png',label:'生成的原图'}]});
 assert.ok(ctx.staleCategories.has('training'),'历史提示词与表单不一致时应提示');
 assert.match(ctx.staleCategories.get('training'),/历史素材/);
 assert.ok(ctx.genUI>0);
 // Loading a prompt identical to the compiled one does not flag it.
 ctx.staleCategories.clear();
 await ctx.openAsset({kind:'generate',prompt:'表单拼出的提示词',ratio:'3:4',id:'y',images:[{name:'image-01.png',url:'/output/y/image-01.png'}]});
 assert.ok(!ctx.staleCategories.has('training'));
 // Free creation never shows the bar.
 ctx.purpose='free';
 await ctx.openAsset({kind:'generate',prompt:'自由',ratio:'1:1',id:'z',images:[{name:'image-01.png',url:'/output/z/image-01.png'}]});
 assert.ok(!ctx.staleCategories.has('free'));
 // An edited record opens straight into the editor with its saved document.
 ctx.opened=null;
 await ctx.openAsset({kind:'upload',prompt:'上传',ratio:'auto',id:'u',edit_url:'/output/u/edit/edit.json',source_url:'/output/u/source.png',images:[{name:'source.png',url:'/output/u/source.png'}]});
 assert.equal(ctx.opened.id,'u');assert.equal(ctx.opened.doc.from,'/output/u/edit/edit.json');assert.equal(ctx.currentImage,'/output/u/source.png');
 // Split records always open as layers, topmost first.
 await ctx.openAsset({kind:'split',prompt:'拆',id:'s',source_url:'/output/s/source.png',zip_url:'/output/s/images.zip',images:[{name:'layer-01.png'},{name:'layer-02.png'}]});
 assert.deepEqual(plainLocal(ctx.opened.layers),[{source:'layer-01.png',label:'图层 01'},{source:'layer-02.png',label:'图层 02'}]);
 assert.equal(ctx.opened.zip,'/output/s/images.zip');assert.equal(ctx.opened.doc,null);
 console.log('素材库载入历史提示词与不一致提示、编辑稿恢复、拆层图层检查通过');

 // test_job_payload_matches_compiled_references
 const values={...TrainingPoster.example(),lecturerMode:'portrait',speakers:[0,1,2,3].map(i=>({...TrainingPoster.defaultSpeaker(i),name:'讲师'+i,photoName:i===1?'':`p${i}.jpg`}))};
 const photos=values.speakers.map((s,i)=>s.photoName?{name:s.photoName,dataUrl:`data:image/jpeg;base64,${i}`}:null);
 const keys={'qwen-key':element(' qk '),'api-key':element('mk')};
 const gen={provider:'qwen',model:'qwen-image-3.0-pro',baseUrl:'https://dashscope.aliyuncs.com/api/v1',maxRefImages:2};
 const p=sandbox({purpose:'training',genSettings:()=>gen,TrainingForm:{read:()=>values,photo:i=>photos[i]}});
 Object.assign(p.els,keys);
 vm.runInContext(slice('function jobPayload(','async function submit('),p);
const plain=v=>JSON.parse(JSON.stringify(v));
 const q=p.jobPayload('generate','提示词','3:4');
 assert.equal(q.provider,'qwen');assert.equal(q.key,'qk');assert.equal(q.purpose,'training');
 assert.deepEqual(q.references.map(r=>r.name),['p0.jpg','p2.jpg']);
 assert.deepEqual(q.references.map(r=>r.name),TrainingPoster.compile(values,{ratio:'3:4',provider:'qwen',maxRefImages:2}).references.map(i=>photos[i].name));
 values.lecturerMode='text';
 assert.deepEqual(plain(p.jobPayload('generate','提示词','3:4').references),[]);
 values.lecturerMode='portrait';
 p.purpose='cover';assert.deepEqual(plain(p.jobPayload('generate','提示词','3:4').references),[]);
 gen.provider='maas';p.purpose='training';
 const m=p.jobPayload('generate','提示词','3:4');
 assert.equal(m.provider,'maas');assert.equal(m.key,'mk');assert.equal(m.references,undefined);
 assert.deepEqual(plain(p.jobPayload('split','拆','3:4')),{kind:'split',prompt:'拆',key:'mk',ratio:'auto',provider:'maas'});
 console.log('生成请求的肖像与提示词编译结果一致检查通过');

 // test_confirm_before_generating_with_stale_prompt
 const asked=[];
 const c=sandbox({staleCategories:new Map([['training','生图设置已变，提示词可能不再准确。']]),confirm:m=>{asked.push(m);return c.answer;}});
 vm.runInContext(slice('function confirmStale(','async function submit('),c);
 c.answer=false;
 assert.equal(c.confirmStale('training',2),false,'取消时不应生成');
 assert.match(asked[0],/生图设置已变/);assert.match(asked[0],/2 张讲师肖像/);
 c.answer=true;
 assert.equal(c.confirmStale('training',0),true);
 assert.ok(!/张讲师肖像/.test(asked[1]),'不发肖像时不提肖像');
 assert.equal(c.confirmStale('cover',3),true);
 assert.equal(asked.length,2,'没有提示条的品类不弹确认');
 console.log('提示词与生图设置不一致时，生成前确认检查通过');
 // test_busy_steps_follow_the_real_job_status — 等待时的步骤只跟后端真实状态走，不编造百分比
 assert.deepEqual(plainLocal(c.busySteps('generate')),['提交请求','排队','生成中','载入结果']);
 assert.deepEqual(plainLocal(c.busySteps('split')),['上传原图','排队','拆解图层','载入图层']);
 assert.equal(c.stepOf('queued'),1);assert.equal(c.stepOf('running'),2);assert.equal(c.stepOf('done'),3);
 assert.equal(c.stepOf('something-new'),1,'没见过的状态按排队算，不跳步');
 console.log('等待步骤按任务状态推进检查通过');

 const formCtx={TrainingPoster,document:{},localStorage:{getItem:()=>null,setItem(){}},URL:{}};
 vm.createContext(formCtx);
 vm.runInContext(fs.readFileSync(__dirname+'/static/training-form.js','utf8')+';this.TrainingForm=TrainingForm;',formCtx);
 // test_lecturer_mode_cards_have_pictures — 呈现方式改成带示意图的卡片，和封面风格一样
 const cards=formCtx.TrainingForm.modeCards();
 for(const key of Object.keys(TrainingPoster.LECTURER_MODES)){
  assert.ok(cards.includes(`data-mode="${key}"`),key);
  assert.ok(cards.includes(`src="/lecturer-modes/${key}.svg"`),key);
  assert.ok(fs.existsSync(`${__dirname}/static/lecturer-modes/${key}.svg`),key);
  assert.ok(cards.includes(TrainingPoster.LECTURER_MODES[key]),key);
 }
 assert.equal((cards.match(/class="style-card mode-card"/g)||[]).length,3);
 assert.ok(cards.includes('主视觉不放人物'));
 console.log('讲师呈现方式示意图卡片检查通过');

 // test_clear_stage_resets_canvas_but_keeps_work
 const stage=sandbox({currentImage:'/output/a/image-01.png',currentAsset:{id:'a'},hidden:0,flushed:0,
  setMode(m){stage.mode=m;},confirm:()=>stage.answer,flushSave:async()=>{stage.flushed++;},hideEditor(){stage.hidden++;},
  PosterEditor:{isSample:()=>stage.isSample,isOpen:()=>true,canUndo:()=>true}});
 for(const id of ['preview-image','download-original','next-actions','clear-stage'])stage.els[id]={...element(),hidden:false,removeAttribute(){this.src='';}};
 stage.els['empty-state']={...element(),hidden:true};
 stage.els['generate-prompt']=element('我的提示词');
 vm.runInContext(slice('async function clearStage(','$(\'clear-stage\').onclick'),stage);
 stage.isSample=true;stage.answer=false;await stage.clearStage();
 assert.equal(stage.hidden,0,'示例有改动时，取消确认不应清空');
 stage.isSample=false;stage.answer=false;await stage.clearStage();
 assert.equal(stage.flushed,1,'清空前先保存编辑稿（不需要确认）');assert.equal(stage.hidden,1);
 assert.equal(stage.currentImage,null);assert.equal(stage.currentAsset,null);
 assert.equal(stage.els['empty-state'].hidden,false);
 for(const id of ['preview-image','download-original','next-actions','clear-stage'])assert.equal(stage.els[id].hidden,true,id);
 assert.equal(stage.mode,'generate');
 assert.equal(stage.els['generate-prompt'].value,'我的提示词','清空画布不动提示词');
 console.log('清空画布：示例确认、先保存、重置画布、保留提示词检查通过');

 // test_autosave_debounces_and_retries
 {
  const timers=[];const saves=[];let fail=false;
  const a=sandbox({currentAsset:null,setTimeout:(fn)=>{timers.push(fn);return timers.length;},clearTimeout(){},
   postJSON:async(url,body)=>{saves.push([url,body]);if(fail)throw new Error('磁盘已满');return {ok:true};},
   PosterEditor:{isOpen:()=>true,hasPending:()=>false,flush(){},toDoc:()=>({version:1,objects:[1]})},addEventListener(){}});
  a.els['save-state']={...element(),dataset:{}};
  vm.runInContext(slice('let saveTimer=null','$(\'save-state\').onclick'),a);
  a.onEditorChange();assert.equal(timers.length,0,'示例（没有记录）不保存');
  vm.runInContext("currentAsset={id:'rec1'}",a);
  a.onEditorChange();a.onEditorChange();assert.equal(a.els['save-state'].dataset.state,'pending');
  await a.flushSave();
  assert.equal(saves.length,1,'连续改动只保存一次');
  assert.deepEqual(plainLocal(saves[0]),['/api/edits/save',{asset_id:'rec1',doc:{version:1,objects:[1]}}]);
  assert.equal(a.els['save-state'].dataset.state,'saved');
  fail=true;a.onEditorChange();await a.flushSave();
  assert.equal(a.els['save-state'].dataset.state,'error');assert.match(a.notices.at(-1)[0],/磁盘已满/);
  fail=false;await a.flushSave();
  assert.equal(saves.length,3,'失败后仍有未保存改动，下次会重试');assert.equal(a.els['save-state'].dataset.state,'saved');
  console.log('自动保存：示例不存、防抖合并、失败提示与重试检查通过');
 }

 // test_apply_carry_rescales_and_copies_uploads
 {
  const added=[];let carried=null;
  const c=sandbox({EditorCore,currentAsset:{id:'new'},
   postJSON:async(url,body)=>{carried=[url,body];return {sources:{'edit/upload-aaaaaaaaaaaa.png':'edit/upload-bbbbbbbbbbbb.png'}};},
   PosterEditor:{scene:()=>({width:896}),addObjects:async list=>{added.push(...list);return 0;}}});
  vm.runInContext(slice('async function applyCarry(','$(\'restore-original\').onclick'),c);
  const objects=[{kind:'text',left:1140,top:100,scaleX:1,scaleY:1},{kind:'image',source:'edit/upload-aaaaaaaaaaaa.png',left:570,top:0,scaleX:2,scaleY:2},
   {kind:'image',source:'layer-01.png',left:0,top:0,scaleX:1,scaleY:1},{kind:'image',source:'mem:1',left:0,top:0,scaleX:1,scaleY:1}];
  const lost=await c.applyCarry({from:'old',width:1140,objects});
  assert.equal(lost,2,'拆层副本和示例里的图片无法迁移');
  assert.deepEqual(plainLocal(carried),['/api/edits/carry',{from:'old',to:'new',sources:['edit/upload-aaaaaaaaaaaa.png']}]);
  assert.equal(added.length,2);
  assert.ok(Math.abs(added[0].left-896)<1e-9&&Math.abs(added[1].scaleX-2*896/1140)<1e-9,'按宽度比例换算');
  assert.equal(added[1].source,'edit/upload-bbbbbbbbbbbb.png');
  console.log('拆层迁移：按比例换算、复制上传图片、无法迁移计数检查通过');
 }

 // test_merge_extracted_replaces_form_and_keeps_photos_by_name
 const current={values:{...TrainingPoster.example(),lecturerMode:'feature',speakers:[{...TrainingPoster.defaultSpeaker(0),name:'明哥',photoName:'ming.jpg'},{...TrainingPoster.defaultSpeaker(1),name:'林悦',photoName:'lin.jpg'}]},
  photos:[{name:'ming.jpg',dataUrl:'data:m'},{name:'lin.jpg',dataUrl:'data:l'}]};
 const extracted={topic:'安全生产月',audiences:['全体员工'],date:'',time:'',venue:'',format:'线上',headline:'',sub:'',cta:'',courseList:['隐患排查'],
  speakers:[{name:'王工',title:'安全总监',bio:''},{name:'明哥',title:'副总裁',bio:''}]};
 const merged=plain(formCtx.TrainingForm.mergeExtracted(current,extracted));
 assert.equal(merged.values.topic,'安全生产月');
 assert.equal(merged.values.headline,'','原文没有的字段清空，不保留示例');
 assert.equal(merged.values.venue,'');
 assert.equal(merged.values.format,'线上');
 assert.equal(merged.values.lecturerMode,'feature','呈现方式不被识别结果改动');
 assert.deepEqual(merged.values.speakers.map(s=>[s.name,s.title]),[['王工','安全总监'],['明哥','副总裁']]);
 assert.ok(merged.values.speakers.every(s=>TrainingPoster.POSES[s.pose]&&TrainingPoster.OUTFITS[s.outfit]));
 assert.deepEqual(merged.photos,[null,{name:'ming.jpg',dataUrl:'data:m'}],'同名讲师保留肖像');
 const none=plain(formCtx.TrainingForm.mergeExtracted(current,{...extracted,speakers:[]}));
 assert.deepEqual([none.values.speakers,none.photos],[[],[]]);
 console.log('AI 识别结果整表替换、同名讲师保留肖像检查通过');

 // test_apply_env_settings_overrides_browser_values
 // Radios in one group behave like the browser: checking one unchecks the rest.
 const radios={};const radio=(value,on)=>{let state=on;return {value,get checked(){return state;},set checked(v){if(v)for(const r of Object.values(radios))if(r!==this)r.checked=false;state=v;}};};
 radios.qwen=radio('qwen',true);radios.maas=radio('maas',false);
 const envCtx=sandbox({document:{querySelector:sel=>radios[(sel.match(/value="(\w+)"/)||[])[1]]||null}});
 for(const [id,v] of Object.entries({'qwen-model':'qwen-image-3.0-pro','text-model':'qwen-plus','qwen-base-url':'https://dashscope.aliyuncs.com/api/v1'}))envCtx.els[id]=element(v);
 vm.runInContext(slice('function applyEnvSettings(','function rememberGenSettings('),envCtx);
 assert.equal(envCtx.applyEnvSettings({gen_provider:'',qwen_image_model:'',qwen_text_model:'',qwen_base_url:''}),false,'.env 没写的项不改页面');
 assert.equal(envCtx.els['text-model'].value,'qwen-plus');
 assert.equal(envCtx.applyEnvSettings({gen_provider:'maas',qwen_image_model:'qwen-image-2.1-pro',qwen_text_model:'qwen-flash',qwen_base_url:'https://ws1.cn-beijing.maas.aliyuncs.com/api/v1'}),true);
 assert.deepEqual([radios.maas.checked,radios.qwen.checked],[true,false]);
 assert.deepEqual(['qwen-model','text-model','qwen-base-url'].map(id=>envCtx.els[id].value),['qwen-image-2.1-pro','qwen-flash','https://ws1.cn-beijing.maas.aliyuncs.com/api/v1']);
 console.log('.env 里的生图与文本模型设置覆盖页面默认值检查通过');
})().catch(error=>{console.error(error);process.exitCode=1;});
