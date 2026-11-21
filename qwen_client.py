"""Qwen / Alibaba Cloud Bailian image generation. Python standard library only.

Ported from ref培训海报生成器/ai-proxy.js (v3.7). Tested behaviour kept as-is:
- On Bailian official domains, image models must use the native DashScope endpoint;
  compatible-mode /images/generations returns 404 there.
- The native endpoint can answer HTTP 200 with an error in code/message.
- Native image URLs are temporary OSS links, so they are downloaded immediately.
"""
import base64
import json
import re
import urllib.parse
import urllib.request

TIMEOUT = 600
DOWNLOAD_LIMIT = 20 * 1024 * 1024
SIZES = {'1:1': (1328, 1328), '3:4': (1140, 1472), '4:3': (1472, 1140),
         '9:16': (928, 1664), '16:9': (1664, 928), '5:2': (1664, 928)}
AUTO_RATIO = {'training': '3:4', 'cover': '16:9', 'free': '1:1'}


def detect_protocol(model, base_url):
    b = str(base_url or '').lower()
    is_qwen_image = bool(re.match(r'qwen-image', model, re.I) or re.match(r'wanx', model, re.I))
    if '/api/v1' in b: return 'dashscope'
    if 'compatible-mode' in b:
        if re.search(r'dashscope|aliyuncs\.com', b) and is_qwen_image: return 'dashscope'
        return 'qwen'
    if re.fullmatch(r'qwen-image[\w.-]*', model, re.I) or re.match(r'wanx', model, re.I): return 'qwen'
    if re.search(r'qianwenaiapi|qianwenai\.com|dashscope', b): return 'qwen'
    return 'openai'


def dashscope_origin(base_url):
    parsed = urllib.parse.urlparse(str(base_url or '').strip())
    if not parsed.scheme or not parsed.netloc: return 'https://dashscope.aliyuncs.com'
    return f'{parsed.scheme}://{parsed.netloc}'


def max_ref_images(model):
    return 10 if re.search(r'qwen-image-2\.1', model, re.I) else 3


def qwen_size(ratio, purpose):
    if ratio not in SIZES: ratio = AUTO_RATIO.get(purpose, '1:1')
    return SIZES[ratio]


def _mime(blob):
    if blob.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png'
    if blob.startswith(b'\xff\xd8\xff'): return 'image/jpeg'
    if blob.startswith(b'RIFF') and blob[8:12] == b'WEBP': return 'image/webp'
    raise ValueError('图片格式不支持，请上传 PNG、JPEG 或 WebP。')


def _data_url(blob):
    return f'data:{_mime(blob)};base64,{base64.b64encode(blob).decode()}'


def _post(url, key, payload):
    req = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(), headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Accept': 'application/json',
    }, method='POST')
    with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
        try: return json.load(response)
        except ValueError: raise ValueError('上游图片服务返回了无法识别的数据。')


def _download(url):
    if urllib.parse.urlparse(url).scheme != 'https': raise ValueError('服务返回了不支持的图片地址。')
    with urllib.request.urlopen(url, timeout=60) as response:
        blob = response.read(DOWNLOAD_LIMIT + 1)
    if len(blob) > DOWNLOAD_LIMIT: raise ValueError('返回图片超过 20 MB。')
    return blob


def request_image(key, model, base_url, prompt, size, refs):
    """Return (images: list[bytes], warnings: list[str]). HTTPError propagates to the caller."""
    if urllib.parse.urlparse(base_url).scheme != 'https': raise ValueError('千问 Base URL 必须以 https:// 开头。')
    protocol = detect_protocol(model, base_url)
    if protocol == 'openai': raise ValueError('当前仅支持千问 / 百炼图像模型，请检查模型名与 Base URL。')
    limit = max_ref_images(model)
    used, warnings = list(refs[:limit]), []
    if len(refs) > limit: warnings.append(f'参考图超过模型上限 {limit} 张，已舍弃 {len(refs) - limit} 张讲师肖像。')
    width, height = size
    if protocol == 'dashscope':
        content = [{'text': prompt}] + [{'image': _data_url(blob)} for blob in used]
        data = _post(dashscope_origin(base_url) + '/api/v1/services/aigc/multimodal-generation/generation', key, {
            'model': model, 'input': {'messages': [{'role': 'user', 'content': content}]},
            'parameters': {'size': f'{width}*{height}', 'n': 1, 'prompt_extend': False, 'watermark': False}})
        if isinstance(data, dict) and data.get('code'): raise ValueError(str(data.get('message') or data['code']))
        try: parts = data['output']['choices'][0]['message']['content']
        except (KeyError, IndexError, TypeError): parts = []
        urls = [part['image'] for part in parts if isinstance(part, dict) and isinstance(part.get('image'), str) and part['image']]
        if not urls: raise ValueError('上游图片服务返回了无法识别的数据。')
        return [_download(url) for url in urls[:1]], warnings
    payload = {'model': model, 'prompt': prompt, 'size': f'{width}x{height}', 'n': 1, 'prompt_extend': False}
    if used: payload['image'] = [_data_url(blob) for blob in used]
    base = base_url.rstrip('/')
    url = base if re.search(r'/images/generations$', base, re.I) else base + '/images/generations'
    data = _post(url, key, payload)
    items = data.get('data') if isinstance(data, dict) else None
    if not items or not isinstance(items[0], dict): raise ValueError('上游图片服务返回了无法识别的数据。')
    item = items[0]
    if item.get('b64_json'): return [base64.b64decode(item['b64_json'], validate=True)], warnings
    if item.get('url'): return [_download(item['url'])], warnings
    raise ValueError('上游图片服务返回了无法识别的数据。')
