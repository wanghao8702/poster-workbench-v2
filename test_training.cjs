const assert=require('node:assert/strict');
const T=require('./static/training-prompt.js');
const qwen={ratio:'3:4',provider:'qwen',maxRefImages:3};
const base=T.example();

// test_example_is_valid
assert.ok(base.topic&&base.speakers.length===1&&base.courseList.length===3);
assert.deepEqual(base.audiences,['管理层']);
assert.equal(base.lecturerMode,'portrait');
// test_requires_topic
assert.throws(()=>T.compile({...base,topic:'  '},qwen),/请先填写培训主题/);
// test_headline_falls_back_to_topic
assert.ok(T.compile({...base,headline:''},qwen).prompt.includes(`“${base.topic}”`));
// test_minimal_values_have_no_empty_quotes
const min={topic:'安全生产月',audiences:[],date:'',time:'',venue:'',format:'线下',headline:'',sub:'',cta:'',courseList:[],lecturerMode:'text',speakers:[]};
const p=T.compile(min,qwen).prompt;
assert.ok(!p.includes('“”'));
assert.ok(!/讲师|参考图/.test(p),p);
assert.ok(!/undefined|null|NaN/.test(p));
// test_blank_speaker_is_ignored
assert.ok(!/讲师/.test(T.compile({...min,lecturerMode:'portrait',speakers:[{...T.defaultSpeaker(0)}]},qwen).prompt));
// test_text_mode_ignores_photo_only_speaker
const photoOnly={...min,lecturerMode:'text',speakers:[{...T.defaultSpeaker(0),photoName:'a.jpg'}]};
assert.ok(!/讲师/.test(T.compile(photoOnly,qwen).prompt));
assert.ok(T.compile({...photoOnly,lecturerMode:'portrait'},qwen).prompt.includes('出镜讲师'));
// test_date_format
assert.ok(T.compile({...base,date:'2026-03-05'},qwen).prompt.includes('2026 年 3 月 5 日'));
// test_ai_decides_style
assert.ok(p.includes('视觉风格、配色与版式由你根据培训主题'));
assert.ok(!/#16325C|品牌主色|品牌辅色|Logo 参考图|报名二维码/.test(p));
assert.ok(p.includes('不要虚构额外的品牌名、口号、徽章、二维码或水印'));
assert.ok(p.includes('不要把'));   // 文案准确性：不要把字段说明标签印到海报上
// test_portraits_with_qwen
const sp=i=>({...T.defaultSpeaker(i),name:'讲师'+i,title:'总监',photoName:`p${i}.jpg`});
const four={...base,lecturerMode:'portrait',speakers:[sp(0),sp(1),sp(2),sp(3)]};
const r=T.compile(four,qwen);
assert.deepEqual(r.references,[0,1,2]);
assert.ok(r.prompt.includes('参考图使用与一致性'));
assert.ok(r.prompt.includes('p2.jpg'));
assert.ok(!r.prompt.includes('p3.jpg'));
assert.ok(r.prompt.includes('共使用 3 张参考图'));
// test_reference_skips_speakers_without_photo
assert.deepEqual(T.compile({...four,speakers:[sp(0),{...sp(1),photoName:''},sp(2)]},qwen).references,[0,2]);
// test_maas_sends_no_references
const m=T.compile(four,{...qwen,provider:'maas'});
assert.deepEqual(m.references,[]);
assert.ok(!m.prompt.includes('参考图使用与一致性'));
assert.ok(!m.prompt.includes('.jpg'));
assert.ok(m.prompt.includes('使用中性、专业的虚构形象'));
// test_text_mode_sends_no_references
const t=T.compile({...four,lecturerMode:'text'},qwen);
assert.deepEqual(t.references,[]);
assert.ok(!t.prompt.includes('参考图'));
assert.ok(t.prompt.includes('画面中不出现讲师形象'));
// test_feature_mode_lists_poses
const f=T.compile({...four,lecturerMode:'feature'},qwen).prompt;
assert.ok(f.includes(T.POSES[four.speakers[0].pose].desc));
assert.ok(f.includes(T.OUTFITS[four.speakers[0].outfit].desc));
// test_multi_speaker_order
assert.ok(r.prompt.includes('讲师阵容共 4 位'));
// test_course_and_cta
const c=T.compile({...base,courseList:['目标对齐','关键对话'],cta:'扫码报名'},qwen).prompt;
assert.ok(c.includes('“目标对齐”、“关键对话”')&&c.includes('“扫码报名”'));
// test_ratio_in_prompt
assert.ok(T.compile(base,{...qwen,ratio:'16:9'}).prompt.includes('16:9'));
assert.ok(T.compile(base,{...qwen,ratio:'auto'}).prompt.includes('3:4'));
assert.ok(T.compile(four,qwen).prompt.length<16000);
// test_default_speaker_rotation
assert.equal(T.defaultSpeaker(1).pose,'seated');
assert.equal(T.defaultSpeaker(2).outfit,'mandarin');
console.log('培训海报提示词：必填、回退、空字段、肖像上限、接口差异、呈现方式通过。');
