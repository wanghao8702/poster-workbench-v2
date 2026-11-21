// Front-end flow checks: run slices of static/app.js against a minimal fake DOM.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const TrainingPoster=require('./static/training-prompt.js');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
const slice=(from,to)=>{const i=source.indexOf(from),j=source.indexOf(to,i);assert.ok(i>=0&&j>i,`slice ${from}`);return source.slice(i,j);};

function element(value=''){return {value,hidden:false,textContent:'',href:'',focus(){},classList:{toggle(){}}};}
function sandbox(extra){
 const els={};
 const $=id=>els[id]||(els[id]=element());
 const ctx={$,els,TrainingPoster,OUTPUT_SIZES:{'1:1':1,'9:16':1,'16:9':1,'5:2':1,'4:3':1,'3:4':1},
  busy:false,sample:true,outputRatio:'auto',currentImage:null,notices:[],
  notify(m,e){ctx.notices.push([m,!!e]);},setBusy(){},setMode(){},closeLibrary(){},showControls(){},countPrompt(){},
  loadSource:async()=>{},loadLayers:async()=>{},orderedLayerItems:i=>i,paintComposition(){},
  updateGenUI(){ctx.genUI=(ctx.genUI||0)+1;},
  document:{createElement:()=>({toDataURL:()=>'data:image/png;base64,'})},
  ...extra};
 vm.createContext(ctx);
 return ctx;
}

// test_open_asset_loads_history_prompt
(async()=>{
 const ctx=sandbox({purpose:'training',PROMPT_IDS:{cover:'cover-prompt',training:'generate-prompt',free:'free-prompt'},
  lastCompiled:{cover:null,training:{prompt:'表单拼出的提示词',ratio:'3:4',provider:'qwen',maxRefImages:3}},staleCategories:new Map()});
 vm.runInContext(slice('const STALE_SETTINGS=','function genSettings(')+'function promptEditor(){return $(PROMPT_IDS[purpose]);}'+slice('async function openAsset(','$(\'open-library\').onclick'),ctx);
 await ctx.openAsset({kind:'generate',prompt:'【画布比例】3:4（宽:高）。\n历史提示词 肖像参考图“a.jpg”',ratio:'3:4',images:[{url:'/output/x/image-01.png'}]});
 assert.deepEqual(ctx.notices.filter(n=>n[1]),[],'载入历史素材不应报错');
 assert.equal(ctx.els['generate-prompt'].value,'历史提示词 肖像参考图“a.jpg”');
 assert.equal(ctx.outputRatio,'auto','载入生成图后按原图尺寸导出，不强制套标准比例');
 assert.ok(ctx.staleCategories.has('training'),'历史提示词与表单不一致时应提示');
 assert.match(ctx.staleCategories.get('training'),/历史素材/);
 assert.ok(ctx.genUI>0);
 // Loading a prompt identical to the compiled one does not flag it.
 ctx.staleCategories.clear();
 await ctx.openAsset({kind:'generate',prompt:'表单拼出的提示词',ratio:'3:4',images:[{url:'/output/y/image-01.png'}]});
 assert.ok(!ctx.staleCategories.has('training'));
 // Free creation never shows the bar.
 ctx.purpose='free';
 await ctx.openAsset({kind:'generate',prompt:'自由',ratio:'1:1',images:[{url:'/output/z/image-01.png'}]});
 assert.ok(!ctx.staleCategories.has('free'));
 console.log('素材库载入历史提示词与不一致提示检查通过');

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

 // test_summary_ignores_photo_only_speaker_in_text_mode
 const formCtx={TrainingPoster,document:{},localStorage:{getItem:()=>null,setItem(){}},URL:{}};
 vm.createContext(formCtx);
 vm.runInContext(fs.readFileSync(__dirname+'/static/training-form.js','utf8')+';this.TrainingForm=TrainingForm;',formCtx);
 const photoOnly={topic:'安全生产月',lecturerMode:'text',speakers:[{name:'',title:'',bio:'',photoName:'a.jpg'},{name:'林悦',title:'',bio:'',photoName:''}]};
 assert.equal(formCtx.TrainingForm.summary(photoOnly),'安全生产月 · 1 位讲师');
 assert.equal(formCtx.TrainingForm.summary({...photoOnly,lecturerMode:'portrait'}),'安全生产月 · 2 位讲师');
 console.log('仅文字模式下只有照片的讲师不计入检查通过');

 // test_clear_stage_resets_canvas_but_keeps_work
 const stage=sandbox({layers:[{}],past:[1],future:[],manualOrder:[0],selectedIndex:0,hoverIndex:-1,drag:null,currentImage:'/output/a/image-01.png',sample:true,
  flow:0,setFlow(n){stage.flow=n;},setMode(m){stage.mode=m;},confirm:()=>stage.answer});
 for(const id of ['editor-controls','layers-section','composition','preview-image','download-original','next-step','clear-stage'])stage.els[id]={...element(),hidden:false,removeAttribute(){this.src='';}};
 stage.els['empty-state']={...element(),hidden:true};
 stage.els['generate-prompt']=element('我的提示词');
 vm.runInContext(slice('function clearStage(','$(\'next-step\').onclick'),stage);
 stage.answer=false;stage.clearStage();
 assert.equal(stage.layers.length,1,'有未导出的图层调整时，取消确认不应清空');
 stage.answer=true;stage.clearStage();
 assert.equal(stage.layers.length,0);assert.equal(stage.currentImage,null);assert.equal(stage.past.length,0);
 assert.equal(stage.els['empty-state'].hidden,false);
 for(const id of ['layers-section','composition','preview-image','download-original','next-step','clear-stage'])assert.equal(stage.els[id].hidden,true,id);
 assert.equal(stage.flow,1);assert.equal(stage.mode,'generate');
 assert.equal(stage.els['generate-prompt'].value,'我的提示词','清空画布不动提示词');
 console.log('清空画布：确认、重置画布、保留提示词检查通过');

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
