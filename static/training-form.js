'use strict';
// Training poster form rendered inside the settings dialog. Text fields persist in localStorage;
// portraits stay in memory only (they can be large and are personal data).
const TrainingForm=(()=>{
 const STORE='poster-v2-training';
 const MAX_SPEAKERS=6;
 const PHOTO_TYPES=['image/png','image/jpeg','image/webp'];
 let root=null,speakers=[],refLimit={provider:'qwen',maxRefImages:3};
 const q=selector=>root.querySelector(selector);
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=i=>String(i+1).padStart(2,'0');
 const options=(map,selected)=>Object.entries(map).map(([key,item])=>`<option value="${key}"${key===selected?' selected':''}>${esc(item.zh)}</option>`).join('');
 const chips=(name,list,multi)=>list.map(value=>`<button type="button" class="chip" data-${name}="${esc(value)}" aria-pressed="false">${esc(value)}</button>`).join('');

 function skeleton(){
  const T=TrainingPoster;
  root.innerHTML=`
  <div class="tf-field"><label class="field-label" for="tf-topic">培训主题 <em class="tf-req">必填</em></label>
   <input id="tf-topic" class="size-select" maxlength="80" placeholder="例：2026 新任管理者领导力加速营"></div>
  <div class="tf-field"><span class="field-label">目标受众 <span>可多选</span></span>
   <div class="tf-chips" role="group" aria-label="目标受众">${chips('audience',T.AUDIENCES)}</div></div>
  <div class="tf-grid">
   <div><label class="field-label" for="tf-date">日期</label><input id="tf-date" type="date" class="size-select"></div>
   <div><label class="field-label" for="tf-time">时间</label><input id="tf-time" type="time" class="size-select"></div>
   <div><span class="field-label">形式</span><div class="tf-chips" role="radiogroup" aria-label="培训形式">${chips('format',Object.keys(T.FORMATS))}</div></div>
  </div>
  <div class="tf-field"><label class="field-label" for="tf-venue">地点 / 线上平台</label><input id="tf-venue" class="size-select" maxlength="80" placeholder="例：总部 B2 国际会议中心"></div>
  <div class="tf-field"><label class="field-label" for="tf-headline">主标题 <span>留空则用培训主题</span></label><input id="tf-headline" class="size-select" maxlength="40" placeholder="例：从优秀个人，到卓越管理者"></div>
  <div class="tf-field"><label class="field-label" for="tf-sub">副标题 / 亮点</label><input id="tf-sub" class="size-select" maxlength="60" placeholder="例：90 天实战式训练 · 业务高管亲授"></div>
  <div class="tf-field"><label class="field-label" for="tf-cta">行动号召 / 报名信息</label><input id="tf-cta" class="size-select" maxlength="40" placeholder="例：3 月 5 日前完成报名"></div>
  <div class="tf-field"><label class="field-label" for="tf-course">课程内容 <span>每行一条</span></label><textarea id="tf-course" class="tf-course" maxlength="600" placeholder="目标对齐与团队共识&#10;关键对话与反馈技巧&#10;90 天落地行动地图"></textarea></div>
  <h3 class="tf-section">讲师</h3>
  <div class="tf-field"><span class="field-label">呈现方式</span><div class="tf-chips" role="radiogroup" aria-label="讲师呈现方式">${Object.entries(T.LECTURER_MODES).map(([key,label])=>`<button type="button" class="chip" data-mode="${key}" aria-pressed="false">${esc(label)}</button>`).join('')}</div></div>
  <p id="ref-limit-hint" class="tf-hint" role="status" hidden></p>
  <div id="tf-speakers" class="tf-speakers"></div>
  <button type="button" id="tf-add-speaker" class="secondary tf-add">＋ 添加讲师</button>`;
  for(const chip of root.querySelectorAll('[data-audience]'))chip.onclick=()=>chip.setAttribute('aria-pressed',String(chip.getAttribute('aria-pressed')!=='true'));
  for(const chip of root.querySelectorAll('[data-format]'))chip.onclick=()=>setSingle('format',chip.dataset.format);
  for(const chip of root.querySelectorAll('[data-mode]'))chip.onclick=()=>{setSingle('mode',chip.dataset.mode);renderSpeakers();};
  q('#tf-add-speaker').onclick=()=>{
   if(speakers.length>=MAX_SPEAKERS)return;
   speakers.push({...TrainingPoster.defaultSpeaker(speakers.length),photo:null});renderSpeakers();
   root.querySelector('.tf-speaker:last-child input[data-key="name"]')?.focus();
  };
 }
 function setSingle(name,value){for(const chip of root.querySelectorAll(`[data-${name}]`))chip.setAttribute('aria-pressed',String(chip.dataset[name]===value));}
 function single(name,fallback){return root.querySelector(`[data-${name}][aria-pressed="true"]`)?.dataset[name]||fallback;}
 function mode(){return single('mode','portrait');}

 function renderSpeakers(){
  const list=q('#tf-speakers'),showLook=mode()!=='text';
  list.replaceChildren(...speakers.map((speaker,i)=>{
   const card=document.createElement('div');card.className='tf-speaker';
   card.innerHTML=`
    <div class="tf-speaker-head"><strong>讲师 ${num(i)}</strong><button type="button" class="quiet tf-remove" aria-label="删除讲师 ${num(i)}">删除</button></div>
    <div class="tf-speaker-body">
     <div class="tf-photo"${showLook?'':' hidden'}>
      <div class="tf-thumb">${speaker.photo?`<img alt="讲师 ${num(i)} 肖像" src="${esc(speaker.photo.dataUrl)}">`:'<span>肖像</span>'}</div>
      <label class="quiet tf-upload">${speaker.photo?'更换':'上传肖像'}<input type="file" accept="image/png,image/jpeg,image/webp"></label>
      ${speaker.photo?'<button type="button" class="quiet tf-photo-clear">移除</button>':''}
     </div>
     <div class="tf-speaker-fields">
      <div class="tf-pair"><input class="size-select" data-key="name" maxlength="20" placeholder="姓名" aria-label="讲师 ${num(i)} 姓名" value="${esc(speaker.name)}">
       <input class="size-select" data-key="title" maxlength="40" placeholder="头衔" aria-label="讲师 ${num(i)} 头衔" value="${esc(speaker.title)}"></div>
      <input class="size-select" data-key="bio" maxlength="80" placeholder="资历（可选）" aria-label="讲师 ${num(i)} 资历" value="${esc(speaker.bio)}">
      <div class="tf-pair"${showLook?'':' hidden'}><select class="size-select" data-key="pose" aria-label="讲师 ${num(i)} 姿势">${options(TrainingPoster.POSES,speaker.pose)}</select>
       <select class="size-select" data-key="outfit" aria-label="讲师 ${num(i)} 着装">${options(TrainingPoster.OUTFITS,speaker.outfit)}</select></div>
     </div>
    </div>
    <p class="tf-photo-error" role="alert" hidden></p>`;
   for(const input of card.querySelectorAll('[data-key]'))input.oninput=input.onchange=()=>{speaker[input.dataset.key]=input.value;};
   card.querySelector('.tf-remove').onclick=()=>{speakers.splice(i,1);renderSpeakers();};
   const file=card.querySelector('input[type=file]');
   file.onchange=async()=>{
    const error=card.querySelector('.tf-photo-error');error.hidden=true;
    try{speaker.photo=await loadPhoto(file.files[0]);renderSpeakers();}
    catch(e){error.textContent=e.message;error.hidden=false;}
    file.value='';
   };
   const clear=card.querySelector('.tf-photo-clear');if(clear)clear.onclick=()=>{speaker.photo=null;renderSpeakers();};
   return card;
  }));
  q('#tf-add-speaker').hidden=speakers.length>=MAX_SPEAKERS;
  updateHint();
 }

 async function loadPhoto(file){
  if(!file)throw new Error('没有选择图片。');
  if(!PHOTO_TYPES.includes(file.type))throw new Error('肖像格式不支持，请上传 PNG、JPEG 或 WebP。');
  if(file.size>20*1024*1024)throw new Error('肖像不能超过 20 MB。');
  const url=URL.createObjectURL(file);
  try{
   const img=new Image();img.src=url;
   try{await img.decode();}catch{throw new Error('图片无法读取，请换一张 PNG、JPEG 或 WebP 照片。');}
   const scale=Math.min(1,1600/Math.max(img.naturalWidth,img.naturalHeight));
   const canvas=document.createElement('canvas');
   canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
   const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
   const base=file.name.replace(/\.[^.]*$/,'').slice(0,40)||'portrait';
   return {name:`${base}.jpg`,dataUrl:canvas.toDataURL('image/jpeg',0.9)};
  }finally{URL.revokeObjectURL(url);}
 }

 function read(){
  return {
   topic:q('#tf-topic').value.trim(),
   audiences:[...root.querySelectorAll('[data-audience][aria-pressed="true"]')].map(chip=>chip.dataset.audience),
   date:q('#tf-date').value,time:q('#tf-time').value,venue:q('#tf-venue').value.trim(),
   format:single('format','线下'),
   headline:q('#tf-headline').value.trim(),sub:q('#tf-sub').value.trim(),cta:q('#tf-cta').value.trim(),
   courseList:q('#tf-course').value.split('\n').map(line=>line.trim()).filter(Boolean),
   lecturerMode:mode(),
   speakers:speakers.map(s=>({name:s.name.trim(),title:s.title.trim(),bio:s.bio.trim(),pose:s.pose,outfit:s.outfit,photoName:s.photo?s.photo.name:''}))
  };
 }
 function write(values){
  const v={...TrainingPoster.example(),...(values||{})};
  q('#tf-topic').value=v.topic||'';
  const audiences=Array.isArray(v.audiences)?v.audiences:[];
  for(const chip of root.querySelectorAll('[data-audience]'))chip.setAttribute('aria-pressed',String(audiences.includes(chip.dataset.audience)));
  q('#tf-date').value=v.date||'';q('#tf-time').value=v.time||'';q('#tf-venue').value=v.venue||'';
  setSingle('format',TrainingPoster.FORMATS[v.format]?v.format:'线下');
  q('#tf-headline').value=v.headline||'';q('#tf-sub').value=v.sub||'';q('#tf-cta').value=v.cta||'';
  q('#tf-course').value=(Array.isArray(v.courseList)?v.courseList:[]).join('\n');
  setSingle('mode',TrainingPoster.LECTURER_MODES[v.lecturerMode]?v.lecturerMode:'portrait');
  speakers=(Array.isArray(v.speakers)?v.speakers:[]).slice(0,MAX_SPEAKERS).map((s,i)=>{
   const base=TrainingPoster.defaultSpeaker(i);
   return {name:String(s?.name||''),title:String(s?.title||''),bio:String(s?.bio||''),
    pose:TrainingPoster.POSES[s?.pose]?s.pose:base.pose,outfit:TrainingPoster.OUTFITS[s?.outfit]?s.outfit:base.outfit,photo:null};
  });
  renderSpeakers();
 }
 function state(){return {values:read(),photos:speakers.map(s=>s.photo)};}
 function restore(saved){write(saved.values);saved.photos.forEach((photo,i)=>{if(speakers[i])speakers[i].photo=photo;});renderSpeakers();}
 function persist(){
  const values=read();values.speakers=values.speakers.map(s=>({...s,photoName:''}));
  try{localStorage.setItem(STORE,JSON.stringify(values));}catch{}
 }
 function mount(element){
  root=element;skeleton();
  let saved=null;
  try{saved=JSON.parse(localStorage.getItem(STORE)||'null');}catch{}
  write(saved&&typeof saved==='object'?saved:TrainingPoster.example());
 }
 function photo(index){return speakers[index]?.photo||null;}
 function photoCount(){return mode()==='text'?0:speakers.filter(s=>s.photo).length;}
 function summary(values){
  const v=values||read();
  const topic=v.topic.length>14?v.topic.slice(0,14)+'…':v.topic;
  const count=v.speakers.filter(s=>s.name||s.title||s.bio||(v.lecturerMode!=='text'&&s.photoName)).length;
  return [topic,count?`${count} 位讲师`:''].filter(Boolean).join(' · ');
 }
 function updateHint(){
  const hint=q('#ref-limit-hint'),n=photoCount(),{provider,maxRefImages}=refLimit;
  let text='';
  if(n&&provider!=='qwen')text='当前生图接口不支持肖像参考，讲师将以虚构形象绘制。';
  else if(n>maxRefImages)text=`当前模型最多参考 ${maxRefImages} 张肖像，第 ${maxRefImages+1} 位起将以虚构形象绘制。`;
  hint.textContent=text;hint.hidden=!text;
 }
 function setRefLimit(settings){refLimit={provider:settings.provider,maxRefImages:settings.maxRefImages};if(root)updateHint();}
 return {mount,read,write,state,restore,persist,photo,photoCount,summary,setRefLimit};
})();
