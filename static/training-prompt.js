'use strict';
// Training poster prompt compiler, adapted from ref培训海报生成器 buildPrompt (structured version).
// Visual style, palette and layout are left to the model; there are no logo, QR or brand-colour fields.
const TrainingPoster=(()=>{
 const POSES={
  standing:{zh:'站姿演讲',desc:'以自然站姿进行讲解，一只手随内容抬起做手势，身体略微朝向听众'},
  seated:{zh:'坐姿对谈',desc:'坐在椅子或沙发边缘进行对谈，双手自然打开，身体前倾表示倾听'},
  mic:{zh:'手持麦克风',desc:'手持麦克风讲话，另一只手做辅助手势，姿态松弛而自信'},
  whiteboard:{zh:'白板讲解',desc:'站在白板或屏幕旁，一手持笔或指向图表，身体侧向内容'},
  gesture:{zh:'侧身指引',desc:'以四分之三侧身站立，手臂向画面信息区或远方做出引导手势'},
  roundtable:{zh:'圆桌讨论',desc:'围坐在圆桌旁参与讨论，手肘自然放在桌面，目光与同伴交流'},
  leaning:{zh:'倚桌轻谈',desc:'轻轻倚靠桌沿或高脚凳，以轻松但专业的姿态与镜头交流'}
 };
 const OUTFITS={
  suit:{zh:'商务正装',desc:'身着合身的深色西装，搭配简洁衬衫，剪裁利落'},
  smart:{zh:'商务休闲',desc:'身着西装外套搭配开领衬衫，正式但不拘谨'},
  casual:{zh:'休闲简约',desc:'身着纯色针织衫或简洁衬衫，搭配干净长裤，克制不随意'},
  uniform:{zh:'行业制服',desc:'身着整洁的行业制服或企业工装，体现专业身份'},
  mandarin:{zh:'中式立领',desc:'身着现代中式立领外套，线条简洁，兼具文化感与专业度'},
  academic:{zh:'学术正装',desc:'身着学术正装或深色正装，佩戴低调的学院元素'}
 };
 const AUDIENCES=['新员工','管理层','技术人员','销售团队','全体员工','客户与合作方'];
 const FORMATS={'线下':'线下培训','线上':'线上直播','混合':'线上线下混合'};
 const LECTURER_MODES={feature:'主讲人出镜',portrait:'肖像 + 简介',text:'仅文字介绍'};
 const AUTO_RATIO='3:4';
 const POSE_KEYS=['standing','seated','mic','whiteboard','gesture','roundtable'];
 const OUTFIT_KEYS=['suit','smart','mandarin','uniform','suit','smart'];

 const str=value=>typeof value==='string'?value.trim():'';
 const num=i=>String(i+1).padStart(2,'0');
 function defaultSpeaker(index){
  const i=Number.isInteger(index)&&index>=0?index:0;
  return {name:'',title:'',bio:'',pose:POSE_KEYS[i%POSE_KEYS.length],outfit:OUTFIT_KEYS[i%OUTFIT_KEYS.length],photoName:''};
 }
 function example(){
  return {topic:'2026 新任管理者领导力加速营',audiences:['管理层'],date:'2026-03-12',time:'09:00',venue:'总部 B2 国际会议中心',format:'线下',
   headline:'从优秀个人，到卓越管理者',sub:'90 天实战式训练 · 业务高管亲授',cta:'3 月 5 日前完成报名',
   courseList:['目标对齐与团队共识','关键对话与反馈技巧','90 天落地行动地图'],lecturerMode:'portrait',
   speakers:[{...defaultSpeaker(0),name:'林悦',title:'人才发展中心总监',bio:'15 年领导力发展与组织变革经验'}]};
 }
 function fmtDate(value){
  const parts=str(value).split('-');
  if(parts.length!==3)return str(value);
  return `${parts[0]} 年 ${parseInt(parts[1],10)} 月 ${parseInt(parts[2],10)} 日`;
 }
 function joinCn(list){
  if(!list.length)return '';
  if(list.length===1)return list[0];
  return list.slice(0,-1).join('、')+'与'+list[list.length-1];
 }

 function compile(values,opts){
  const v=values||{},o=opts||{};
  const topic=str(v.topic);
  if(!topic)throw new Error('请先填写培训主题。');
  const ratio=o.ratio&&o.ratio!=='auto'?o.ratio:AUTO_RATIO;
  const mode=Object.hasOwn(LECTURER_MODES,v.lecturerMode)?v.lecturerMode:'portrait';
  const audiences=(Array.isArray(v.audiences)?v.audiences:[]).map(str).filter(Boolean);
  const audPhrase=joinCn(audiences)||'一般企业员工';
  const headline=str(v.headline)||topic,sub=str(v.sub),cta=str(v.cta);
  const courseList=(Array.isArray(v.courseList)?v.courseList:[]).map(str).filter(Boolean);
  const courseText=courseList.map(item=>`“${item}”`).join('、');
  const details=[fmtDate(v.date),str(v.time),str(v.venue)].filter(Boolean).join(' · ');
  const formatCn=FORMATS[v.format]||FORMATS['线下'];

  // Keep original indexes so the caller can map references back to uploaded photos.
  const speakers=(Array.isArray(v.speakers)?v.speakers:[]).map((s,index)=>({
   index,name:str(s&&s.name),title:str(s&&s.title),bio:str(s&&s.bio),photoName:str(s&&s.photoName),
   pose:POSES[s&&s.pose]?s.pose:'standing',outfit:OUTFITS[s&&s.outfit]?s.outfit:'suit'
  })).filter(s=>s.name||s.title||s.bio||(mode!=='text'&&s.photoName));
  const limit=o.provider==='qwen'&&mode!=='text'?Math.max(0,Number(o.maxRefImages)||0):0;
  const refSpeakers=speakers.filter(s=>s.photoName).slice(0,limit);
  const hasRef=s=>refSpeakers.includes(s);
  const count=speakers.length;
  const label=(s,i)=>`讲师 ${num(i)}${s.name?`（${s.name}）`:''}`;

  const order=['主标题',sub&&'副标题',courseList.length&&'课程内容',count&&'讲师信息',details&&'时间地点信息条',cta&&'行动号召'].filter(Boolean);
  const formatLines=[
   `• 画面比例 ${ratio}（宽:高），按此比例安排完整构图。`,
   `• 培训形式：${formatCn}。`,
   '• 四周保留约 5% 安全边距，确保关键内容不被裁切。',
   `• 阅读顺序：${order.join(' → ')}。`
  ];

  const heroLines=[
   '• 主视觉：围绕培训主题设计一个清晰、有记忆点的主视觉，具体形式由你根据主题与受众判断。',
   `• 通过视觉隐喻而非直白插图来传达“${topic}”——例如上升的形态、打开的路径、升起的地平线或连接的节点。`,
   `• 人物形象、着装与环境需真实贴合${audPhrase}。`,
   '• 人物状态自然投入：表情真实、姿态可信，避免僵硬的图库摆拍感。'
  ];
  if(count&&mode==='feature'){
   heroLines.push(`• 主讲人物以讲师名单为准：画面中只出现 ${count} 位可辨识的讲师，其余听众仅以虚化背影或剪影呈现。`);
   heroLines.push('• 讲师姿态：'+speakers.map((s,i)=>`${s.name||label(s,i)} 为${POSES[s.pose].zh}`).join('；')+'。');
  }

  const styleLines=[
   '• 视觉风格、配色与版式由你根据培训主题、受众与培训形式自行判断，选择最契合企业培训调性的一套方案，全图只用这一种风格；保证信息层级清楚、留白充足、文字对比度达到 WCAG AA 以上。',
   '• 画面需一眼可读，并为信息层级留出明确的呼吸空间。'
  ];

  const typo=[
   '• 字体系统：选择与整体风格匹配的中文字体，标题与正文形成明确的字号与字重对比。',
   `• 主标题（画面最大、最多两行）：“${headline}”——字号约为正文的 3 倍，字距收紧有力。`
  ];
  if(sub)typo.push(`• 副标题：“${sub}”——约为主标题的 45%，常规字重，紧随主标题下方一行。`);
  if(courseList.length)typo.push(`• 课程内容：以 ${courseList.length} 条短句纵向排列——${courseText}；每条一行，小号字，条目之间间距均匀，置于信息条上方。`);
  if(details)typo.push(`• 信息条：“${details}”——小号细字重，项目之间以细线分隔。`);
  if(cta)typo.push(`• 行动号召：“${cta}”——置于醒目的实心胶囊按钮中，放在阅读路径末端。`);
  typo.push('• 所有海报文案使用简体中文；字距均匀，避免孤字，文字不要压在复杂图像上。');
  typo.push('• 引号内的文字是最终海报文案，逐字准确呈现；不要把「主标题」「副标题」「课程内容」等字段说明标签印到海报上，每条文案只出现一次。中文必须可读，无错字、乱码、缺笔画或多余字符。');

  const speakerLines=[];
  if(count){
   if(count===1){
    const s=speakers[0],id=[s.name,s.title].filter(Boolean).join(' — ');
    speakerLines.push(`• 出镜讲师：${id||'特邀讲师'}。`);
   }else{
    speakerLines.push(`• 讲师阵容共 ${count} 位，按以下顺序呈现：`+speakers.map((s,i)=>`${num(i)} ${s.name||'特邀讲师'}${s.title?`（${s.title}）`:''}`).join('；')+'。');
    speakers.forEach((s,i)=>{
     const bits=[];
     if(s.bio)bits.push(`资历“${s.bio}”`);
     if(hasRef(s))bits.push(`肖像参考图“${s.photoName}”`);
     if(bits.length)speakerLines.push(`• 讲师 ${num(i)}：${bits.join('，')}。`);
    });
   }
   if(mode==='feature'){
    speakerLines.push(count===1
     ?'• 讲师作为主视觉中的核心人物：按设定姿势出镜，亲和、专业，正在与听众交流。'
     :`• 讲师作为主视觉中的核心人物：${count} 位讲师在同一场景中按各自设定的姿势出镜，彼此有自然的视线与互动，避免排成僵硬队列；画面中只出现这 ${count} 位讲师，不额外添加其他清晰可辨的人物。`);
   }else if(mode==='portrait'){
    if(count===1)speakerLines.push('• 在文字区内加入一张干净的讲师编辑肖像，圆角矩形卡片，胸部以上裁切，纯净的色调背景，表情自信温和。');
    else{
     const grid=count===2?'左右并置':count===3?'横向三栏':'两行网格、每行最多 3 张';
     speakerLines.push(`• 在文字区放置 ${count} 张统一规格的讲师肖像卡片，${grid}排列；圆角矩形，胸部以上裁切，背景、光比与色调统一。`);
     speakerLines.push('• 每张卡片下方对应一位讲师的姓名与头衔，卡片顺序与讲师名单严格一致。');
    }
   }else speakerLines.push('• 画面中不出现讲师形象，讲师信息仅以文字呈现。');
   if(mode!=='text'){
    speakers.forEach((s,i)=>{
     speakerLines.push(mode==='feature'
      ?`• ${label(s,i)}的出镜姿势与着装：${POSES[s.pose].desc}；${OUTFITS[s.outfit].desc}。`
      :`• ${label(s,i)}的肖像着装：${OUTFITS[s.outfit].desc}；胸部以上半身像，肩部自然微侧。`);
    });
    if(refSpeakers.length){
     speakerLines.push('• 肖像严格按所附参考图绘制：保持每位讲师的面部特征、年龄、发型与气质一致，不得混用不同讲师的面部特征。');
     speakers.forEach((s,i)=>{if(!hasRef(s))speakerLines.push(`• ${label(s,i)}没有肖像参考图：使用中性、专业的虚构形象，不要模仿真实名人。`);});
    }else speakerLines.push('• 未提供讲师肖像参考图时，使用中性、专业的虚构形象，不要模仿真实名人。');
   }
   if(count===1){
    const s=speakers[0];
    if(s.name)speakerLines.push(`• 讲师信息组：“${s.name}”使用中等字重，下方以更小的次要字体排“${s.title||'讲师'}”。`);
    else if(s.title)speakerLines.push(`• 讲师信息组：以较小的次要字体排“${s.title}”。`);
    if(s.bio)speakerLines.push(`• 资历背书：“${s.bio}”——小号细字重，置于讲师信息组下方。`);
   }else{
    speakerLines.push(`• 讲师信息组：${count} 组等宽姓名卡按 01→${num(count-1)} 顺序${count===2?'左右并置':'横向排列'}，每组“姓名”为中等字重，“头衔”为小号次要字体；资历统一置于姓名卡下方。`);
   }
  }

  const lightLines=[
   '• 光影：自然、有层次的光线，与所选风格保持一致。',
   '• 细节等级：边缘清晰、皮肤质感自然、人体结构准确、透视统一，无渲染瑕疵。'
  ];

  const refLines=[];
  if(refSpeakers.length){
   refLines.push(`• 本次生成共使用 ${refSpeakers.length} 张参考图，按讲师顺序作为图像参考一并传入。`);
   speakers.forEach((s,i)=>{if(hasRef(s))refLines.push(`• 讲师肖像参考图：${s.name||label(s,i)} → ${s.photoName}——仅用于该讲师的面部与气质，不得与其他讲师混用。`);});
   refLines.push('• 参考图之间若存在风格或光比差异，以人物身份一致性优先，统一到海报的整体光影与色调。');
   refLines.push('• 不复制参考图中的背景、文字或水印，不添加参考图中不存在的元素。');
  }

  let avoid='错字或乱码文字、多余文字块、水印、额外标志、杂乱版面、扭曲的面部或手部、重复肢体、塑料感皮肤、浑浊或过饱和的色彩、图像上低对比度的文字';
  if(refSpeakers.length)avoid+='、与参考图不符的面部';
  const techLines=[
   `• 输出比例 ${ratio}；高细节；专业广告级完成度。`,
   '• 人物采用摄影级真实感，图形元素保持矢量级干净边缘。',
   '• 不要虚构额外的品牌名、口号、徽章、二维码或水印，不要做成网页截图或设计样机。',
   `• 避免：${avoid}。`
  ];
  if(refSpeakers.length)techLines.push('• 参考图一致性优先于装饰效果：讲师面部需与参考图高度一致，必要时降低背景复杂度。');

  const sections=[
   ['画面规格与版式',formatLines],['主视觉与构图',heroLines],['视觉风格与版式',styleLines],['文字排版与海报文案',typo]
  ];
  if(count)sections.push(['讲师与背书',speakerLines]);
  sections.push(['光影、细节与质感',lightLines]);
  if(refLines.length)sections.push(['参考图使用与一致性',refLines]);
  sections.push(['技术参数与规避项',techLines]);
  const prompt=`企业培训宣传海报 —— “${topic}”。\n\n`+sections.map(([title,lines])=>`【${title}】\n${lines.join('\n')}`).join('\n\n');
  return {prompt,references:refSpeakers.map(s=>s.index)};
 }
 return {POSES,OUTFITS,AUDIENCES,FORMATS,LECTURER_MODES,defaultSpeaker,example,compile};
})();
if(typeof module!=='undefined')module.exports=TrainingPoster;
