'use strict';
// Local runtime settings from .env (or the older .local-key / .local-qwen-key files), served by /api/config.
window.StudioConfig=(()=>{
 const ready=fetch('/api/config').then(async response=>{
  if(!response.ok)throw new Error('服务配置读取失败。');
  const c=await response.json();
  const text=value=>typeof value==='string'?value:'';
  return {source:text(c.source),default_key:text(c.default_key),default_qwen_key:text(c.default_qwen_key),
   gen_provider:text(c.gen_provider),qwen_image_model:text(c.qwen_image_model),qwen_text_model:text(c.qwen_text_model),qwen_base_url:text(c.qwen_base_url)};
 });
 // Startup failures are reported by whoever awaits this; avoid an unhandled rejection meanwhile.
 ready.catch(()=>{});
 return {ready};
})();
