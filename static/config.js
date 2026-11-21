'use strict';
// Local runtime settings: optional default keys read from .local-key / .local-qwen-key.
window.StudioConfig=(()=>{
 const ready=fetch('/api/config').then(async response=>{
  if(!response.ok)throw new Error('服务配置读取失败。');
  const config=await response.json();
  return {default_key:config.default_key||'',default_qwen_key:config.default_qwen_key||''};
 });
 // Startup failures are reported by whoever awaits this; avoid an unhandled rejection meanwhile.
 ready.catch(()=>{});
 return {ready};
})();
