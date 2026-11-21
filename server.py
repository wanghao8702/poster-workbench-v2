#!/usr/bin/env python3
"""Local Cover Studio. Python 3.10+, standard library only."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import mimetypes
import os
import re
from pathlib import Path
import secrets
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
import zipfile

import qwen_client
import training_extract

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
OUTPUT = ROOT / 'output'
ENV_FILE = ROOT / '.env'
KEY_FILE = ROOT / '.local-key'
QWEN_KEY_FILE = ROOT / '.local-qwen-key'
API = 'https://maas-api.antdigital.com/v1'
MODEL = {'generate': 'ming-image-0.1-design', 'split': 'ming-image-0.1-design-layer'}
MAX_BODY = 64 * 1024 * 1024
RATIOS = ('auto', '1:1', '9:16', '16:9', '5:2', '4:3', '3:4')
PURPOSES = ('cover', 'training', 'free')
ASSET_KINDS = ('generate', 'split', 'upload')
EXTRACT_MAX_CHARS = 20000
EXTRACT_FILE_LIMIT = 10 * 1024 * 1024
JOBS = {}
LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=2)


def multipart(fields, image):
    boundary = 'MingStudio' + uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + image + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    return b''.join(parts), 'multipart/form-data; boundary=' + boundary


def image_type(blob):
    if blob.startswith(b'\x89PNG\r\n\x1a\n'): return 'png'
    if blob.startswith(b'\xff\xd8\xff'): return 'jpg'
    if blob.startswith(b'RIFF') and blob[8:12] == b'WEBP': return 'webp'
    raise ValueError('图片格式不支持，请上传 PNG、JPEG 或 WebP。')


def decode_image(value):
    try:
        blob = base64.b64decode(value.split(',', 1)[-1], validate=True)
    except (ValueError, TypeError):
        raise ValueError('图片数据无法读取，请重新上传。')
    if len(blob) > 20 * 1024 * 1024: raise ValueError('图片请控制在 20 MB 以内。')
    image_type(blob)
    return blob


def update(job_id, **values):
    with LOCK: JOBS[job_id].update(values)


def move_asset(asset_id, restore=False):
    if not isinstance(asset_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', asset_id):
        raise ValueError('素材 ID 无效。')
    trash = OUTPUT / '.trash'
    if trash.resolve().parent != OUTPUT.resolve(): raise ValueError('回收目录无效。')
    source = (trash if restore else OUTPUT) / asset_id
    target = (OUTPUT if restore else trash) / asset_id
    with LOCK:
        if JOBS.get(asset_id, {}).get('status') in ('queued', 'running'):
            raise ValueError('素材仍在处理中，请稍后再试。')
        if source.is_symlink() or not (source/'manifest.json').is_file():
            raise ValueError('素材不存在或已移除。')
        if target.exists(): raise ValueError('目标目录已存在，无法移动素材。')
        target.parent.mkdir(parents=True, exist_ok=True)
        source.rename(target)


def asset_info(folder):
    """One library entry for a record folder, or None when the folder is not a complete record."""
    data = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    kind = data.get('kind')
    if kind not in ASSET_KINDS: return None
    images = []
    for item in data.get('images', []):
        name = item.get('name', '')
        if not name or Path(name).name != name: continue
        if (folder / name).is_file():
            images.append({'name': name, 'url': f'/output/{folder.name}/{urllib.parse.quote(name)}'})
    if not images: return None
    source = data.get('source_name', '')
    source_url = f'/output/{folder.name}/{urllib.parse.quote(source)}' if source and Path(source).name == source and (folder/source).is_file() else None
    edit = folder / 'edit' / 'edit.json'
    edited = edit.is_file()
    return {'id': folder.name, 'kind': kind, 'model': str(data.get('model') or MODEL.get(kind, '')),
            'created_at': float(data.get('created_at', (folder / 'manifest.json').stat().st_mtime)),
            'elapsed': data.get('elapsed'), 'prompt': str(data.get('prompt', '')),
            'ratio': data.get('ratio', 'auto'), 'images': images, 'source_url': source_url,
            'zip_url': f'/output/{folder.name}/images.zip' if (folder/'images.zip').is_file() else None,
            'edited': edited, 'edit_url': f'/output/{folder.name}/edit/edit.json' if edited else None,
            'edited_at': edit.stat().st_mtime if edited else None}


def list_assets():
    """Read completed assets from disk, including jobs from earlier server runs."""
    assets = []
    for path in OUTPUT.glob('*/manifest.json'):
        try:
            info = asset_info(path.parent)
            if info: assets.append(info)
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return sorted(assets, key=lambda item: item['created_at'], reverse=True)


# ---------- Edit documents (static/editor.js) ----------
DOC_LIMIT = 2 * 1024 * 1024
UPLOAD_NAME = re.compile(r'edit/upload-[0-9a-f]{12}\.(?:png|jpg|webp)')
EDIT_NUMBERS = {'left': (-1e6, 1e6), 'top': (-1e6, 1e6), 'scaleX': (0.01, 100), 'scaleY': (0.01, 100), 'angle': (-360, 360),
                'opacity': (0, 1), 'fontSize': (4, 1000), 'lineHeight': (0.5, 5), 'charSpacing': (-500, 2000),
                'width': (1, 1e6), 'height': (1, 1e6), 'rx': (0, 1e6), 'strokeWidth': (0, 200)}
EDIT_STRINGS = {'id': 40, 'name': 40, 'text': 2000, 'fontFamily': 20, 'fill': 9, 'stroke': 9, 'fontWeight': 10,
                'fontStyle': 10, 'textAlign': 10, 'shape': 10, 'source': 160}
COMMON_FIELDS = {'id', 'kind', 'name', 'left', 'top', 'scaleX', 'scaleY', 'angle', 'opacity', 'visible', 'locked'}
EDIT_FIELDS = {
    'split': COMMON_FIELDS | {'source'},
    'image': COMMON_FIELDS | {'source'},
    'text': COMMON_FIELDS | {'text', 'fontFamily', 'fontSize', 'fill', 'fontWeight', 'fontStyle', 'textAlign', 'lineHeight',
                             'charSpacing', 'width', 'stroke', 'strokeWidth', 'shadow'},
    'shape': COMMON_FIELDS | {'shape', 'width', 'height', 'rx', 'fill', 'stroke', 'strokeWidth'},
}


def asset_dir(asset_id):
    """Folder of an existing, finished record. Rejects ids that could reach outside output/."""
    if not isinstance(asset_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', asset_id):
        raise ValueError('素材 ID 无效。')
    folder = OUTPUT / asset_id
    if folder.is_symlink() or not (folder / 'manifest.json').is_file(): raise ValueError('素材不存在或已移除。')
    with LOCK:
        if JOBS.get(asset_id, {}).get('status') in ('queued', 'running'): raise ValueError('素材仍在处理中，请稍后再试。')
    return folder


def record_files(folder):
    """Model output files a document may reference directly (never the manifest or anything outside the folder)."""
    data = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    names = {item.get('name', '') for item in data.get('images', []) if isinstance(item, dict)}
    names.add(data.get('source_name') or '')
    return {n for n in names if n and isinstance(n, str) and Path(n).name == n and (folder / n).is_file()}


def _number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value): return None
    return min(high, max(low, value))


def clean_object(raw, folder, files):
    if not isinstance(raw, dict) or raw.get('kind') not in EDIT_FIELDS: raise ValueError('编辑稿里有不认识的图层类型。')
    kind, out = raw['kind'], {}
    for key in EDIT_FIELDS[kind]:
        if key not in raw: continue
        value = raw[key]
        if key in EDIT_NUMBERS:
            value = _number(value, *EDIT_NUMBERS[key])
        elif key in EDIT_STRINGS:
            value = value[:EDIT_STRINGS[key]] if isinstance(value, str) else None
        elif key in ('visible', 'locked'):
            value = value if isinstance(value, bool) else None
        elif key == 'shadow':
            value = {k: _number(value.get(k), -500, 500) or 0 for k in ('blur', 'offsetX', 'offsetY')} | \
                {'color': value['color'][:9] if isinstance(value.get('color'), str) else '#000000'} if isinstance(value, dict) else None
        elif key == 'kind':
            pass
        if value is not None or key in ('stroke', 'shadow'): out[key] = value
    if kind in ('split', 'image'):
        source = out.get('source', '')
        allowed = source in files or (kind == 'image' and UPLOAD_NAME.fullmatch(source) and (folder / source).is_file())
        if not allowed: raise ValueError('编辑稿引用了不存在或不允许的图片文件。')
    return out


def clean_doc(doc, folder):
    if not isinstance(doc, dict): raise ValueError('编辑稿格式错误。')
    if len(json.dumps(doc, ensure_ascii=False).encode()) > DOC_LIMIT: raise ValueError('编辑稿过大（上限 2 MB）。')
    if doc.get('version') != 1: raise ValueError('编辑稿版本不支持。')
    objects = doc.get('objects')
    if not isinstance(objects, list) or len(objects) > 200: raise ValueError('图层数量无效（最多 200 个）。')
    size = doc.get('size') if isinstance(doc.get('size'), dict) else {}
    files = record_files(folder)
    return {'version': 1,
            'size': {'width': _number(size.get('width'), 1, 20000) or 1, 'height': _number(size.get('height'), 1, 20000) or 1},
            'outputRatio': doc.get('outputRatio') if doc.get('outputRatio') in RATIOS else 'auto',
            'objects': [clean_object(o, folder, files) for o in objects]}


def import_asset(payload):
    """Turn an uploaded design into a library record so it can be edited and split like a generated image."""
    blob = decode_image(payload.get('data', ''))
    ext = image_type(blob)
    asset_id = secrets.token_urlsafe(18)
    folder = OUTPUT / asset_id
    folder.mkdir(parents=True)
    (folder / f'source.{ext}').write_bytes(blob)
    name = payload.get('name') if isinstance(payload.get('name'), str) else ''
    manifest = {'kind': 'upload', 'model': '', 'provider': '', 'images': [{'name': f'source.{ext}'}],
                'source_name': f'source.{ext}', 'prompt': f'上传的图片：{Path(name).name[:80]}' if name else '上传的图片',
                'ratio': 'auto', 'created_at': time.time()}
    (folder / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return asset_info(folder)


def _store_upload(folder, blob):
    (folder / 'edit').mkdir(exist_ok=True)
    source = f'edit/upload-{secrets.token_hex(6)}.{image_type(blob)}'
    (folder / source).write_bytes(blob)
    return source


def edit_upload(payload):
    folder = asset_dir(payload.get('asset_id'))
    source = _store_upload(folder, decode_image(payload.get('data', '')))
    return {'source': source, 'url': f'/output/{folder.name}/{source}'}


def save_edit(payload):
    folder = asset_dir(payload.get('asset_id'))
    doc = clean_doc(payload.get('doc'), folder)
    (folder / 'edit').mkdir(exist_ok=True)
    target = folder / 'edit' / 'edit.json'
    temp = target.with_suffix('.json.tmp')
    temp.write_text(json.dumps(doc, ensure_ascii=False), encoding='utf-8')
    os.replace(temp, target)
    return {'ok': True, 'updated_at': target.stat().st_mtime}


def reset_edit(payload):
    """Keep the old edit recoverable by hand: move it into the trash instead of deleting it."""
    folder = asset_dir(payload.get('asset_id'))
    edit = folder / 'edit'
    if edit.is_dir() and not edit.is_symlink():
        trash = OUTPUT / '.trash'
        trash.mkdir(exist_ok=True)
        edit.rename(trash / f'{folder.name}-edit-{int(time.time() * 1000)}')
    return {'ok': True}


def carry_edit(payload):
    """Copy uploaded images from one record to another; the editor rescales the objects itself."""
    source_dir, target_dir = asset_dir(payload.get('from')), asset_dir(payload.get('to'))
    sources = payload.get('sources')
    if not isinstance(sources, list) or len(sources) > 200: raise ValueError('要迁移的图片列表无效。')
    mapping = {}
    for source in sources:
        if not isinstance(source, str) or not UPLOAD_NAME.fullmatch(source) or not (source_dir / source).is_file():
            raise ValueError('只能迁移本记录里上传的图片。')
        mapping[source] = _store_upload(target_dir, (source_dir / source).read_bytes())
    return {'sources': mapping}


EDIT_ROUTES = {'/api/assets/import': import_asset, '/api/edits/upload': edit_upload, '/api/edits/save': save_edit,
               '/api/edits/reset': reset_edit, '/api/edits/carry': carry_edit}


def run_job(job_id, kind, key, prompt, image, ratio='auto', qwen=None):
    start = time.monotonic()
    try:
        update(job_id, status='running')
        folder = OUTPUT / job_id
        folder.mkdir(parents=True, exist_ok=True)
        source_name = None
        model, warnings, result = MODEL[kind], [], {}
        if kind == 'generate' and qwen:
            model = qwen['model']
            blobs, warnings = qwen_client.request_image(key, model, qwen['base_url'], prompt,
                                                         qwen_client.qwen_size(ratio, qwen['purpose']), qwen['references'])
            for idx, ref in enumerate(qwen['references'], 1):
                (folder / f'ref-{idx:02d}.{image_type(ref)}').write_bytes(ref)
            result = {'data': [{'b64_json': base64.b64encode(blob).decode()} for blob in blobs]}
        elif kind == 'generate':
            body = json.dumps({'model': MODEL[kind], 'prompt': prompt}, ensure_ascii=False).encode()
            mime = 'application/json'
            endpoint = '/images/generations'
        else:
            body, mime = multipart({'model': MODEL[kind], 'prompt': prompt}, image)
            # Match the actual upload format rather than the filename's extension.
            ext = image_type(image)
            source_name = f'source.{ext}'
            (folder/source_name).write_bytes(image)
            image_mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'webp': 'image/webp'}[ext]
            body = body.replace(b'filename="input.png"\r\nContent-Type: image/png', f'filename="input.{ext}"\r\nContent-Type: {image_mime}'.encode(), 1)
            endpoint = '/images/edits'
        if not result:
            req = urllib.request.Request(API + endpoint, data=body, headers={
                'Authorization': 'Bearer ' + key, 'Content-Type': mime,
            }, method='POST')
            with urllib.request.urlopen(req, timeout=600) as response:
                result = json.load(response)
        images = []
        for idx, item in enumerate(result.get('data', []), 1):
            if item.get('b64_json'):
                blob = base64.b64decode(item['b64_json'], validate=True)
            elif item.get('url'):
                blob = qwen_client.download_image(item['url'])
            else:
                continue
            ext = image_type(blob)
            filename = f'{"image" if kind == "generate" else "layer"}-{idx:02d}.{ext}'
            (folder / filename).write_bytes(blob)
            images.append({'url': f'/output/{job_id}/{filename}', 'name': filename})
        if not images: raise ValueError('服务未返回图片，请检查模型权限或稍后重试。')
        elapsed = round(time.monotonic() - start, 1)
        manifest = {'model': model, 'provider': 'qwen' if qwen and kind == 'generate' else 'maas', 'warnings': warnings, 'kind': kind, 'elapsed': elapsed, 'images': images,
                    'created_at': time.time(), 'source_name': source_name, 'ratio': ratio,
                    'usage': result.get('usage'), 'prompt': prompt,
                    'note': '图层顺序保留模型返回顺序。文字图层为像素图。'}
        (folder / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        (folder / 'prompt.txt').write_text(prompt, encoding='utf-8')
        with zipfile.ZipFile(folder / 'images.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
            for item in images: archive.write(folder / item['name'], item['name'])
            archive.write(folder / 'manifest.json', 'manifest.json')
            archive.write(folder / 'prompt.txt', 'prompt.txt')
        update(job_id, status='done', elapsed=elapsed, images=images, usage=result.get('usage'), warnings=warnings,
               zip_url=f'/output/{job_id}/images.zip')
    except urllib.error.HTTPError as exc:
        update(job_id, status='error', error=http_error_message(exc, key))
    except Exception as exc:
        message = str(exc).replace(key, '[REDACTED]')
        update(job_id, status='error', error=f'请求失败：{message[:600]}')
    finally:
        key = None


def load_env(path):
    """Parse a simple KEY=VALUE .env file (comments, `export`, quotes, BOM). Missing file -> {}."""
    values = {}
    try: text = path.read_text(encoding='utf-8-sig')
    except (OSError, UnicodeDecodeError): return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'): continue
        if line.startswith('export '): line = line[7:].lstrip()
        name, sep, value = line.partition('=')
        name, value = name.strip(), value.strip()
        if not sep or not re.fullmatch(r'[A-Za-z_]\w*', name): continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'': value = value[1:-1]
        else: value = re.sub(r'\s+#.*$', '', value)
        values[name] = value
    return values


def _valid_key(value):
    return value if isinstance(value, str) and 0 < len(value) <= 512 and '\n' not in value and '\r' not in value else ''


def local_config():
    """Defaults for the page, read fresh on every request so editing .env only needs a browser refresh."""
    env = load_env(ENV_FILE)
    legacy = lambda path: path.read_text(encoding='utf-8').strip() if path.is_file() else ''
    maas, qwen = _valid_key(env.get('MAAS_API_KEY', '')), _valid_key(env.get('QWEN_API_KEY', ''))
    source = '.env' if maas or qwen else ''
    if not maas: maas = _valid_key(legacy(KEY_FILE))
    if not qwen: qwen = _valid_key(legacy(QWEN_KEY_FILE))
    if not source and (maas or qwen): source = '.local-key'
    model = lambda name: env.get(name, '') if re.fullmatch(r'[\w.\-]{1,100}', env.get(name, '')) else ''
    base_url = env.get('QWEN_BASE_URL', '')
    parsed = urllib.parse.urlparse(base_url)
    return {'runtime': 'local', 'source': source, 'default_key': maas, 'default_qwen_key': qwen,
            'gen_provider': env.get('GEN_PROVIDER', '') if env.get('GEN_PROVIDER') in ('qwen', 'maas') else '',
            'qwen_image_model': model('QWEN_IMAGE_MODEL'), 'qwen_text_model': model('QWEN_TEXT_MODEL'),
            'qwen_base_url': base_url if parsed.scheme == 'https' and parsed.netloc and len(base_url) <= 500 else ''}


def env_port(default=8765):
    value = load_env(ENV_FILE).get('PORT', '')
    return int(value) if value.isdigit() and 1 <= int(value) <= 65535 else default


def http_error_message(exc, key):
    """Readable Chinese message for an upstream HTTP error, with the API key removed."""
    detail = exc.read().decode(errors='replace').replace(key, '[REDACTED]')
    try:
        parsed = json.loads(detail)
        detail = (parsed.get('error') or {}).get('message') or parsed.get('message') or detail
    except (ValueError, AttributeError): pass
    detail = str(detail).replace(key, '[REDACTED]')
    hints = {400: '请求参数被拒绝。', 401: 'API key 无效或已过期。', 403: '当前 key 无权调用模型。',
             404: '上游接口不存在，请检查 Base URL 和模型名。', 429: '额度不足或请求过于频繁。'}
    return f'HTTP {exc.code} · {hints.get(exc.code, "模型服务暂时不可用。")} {detail[:600]}'


def _qwen_settings(payload, model_label):
    key = payload.get('key', '')
    key = key.strip() if isinstance(key, str) else ''
    if not key or len(key) > 512 or '\n' in key or '\r' in key: raise ValueError('请先在「API 设置」填写千问 API Key。')
    model = payload.get('model')
    if not isinstance(model, str) or not re.fullmatch(r'[\w.\-]{1,100}', model): raise ValueError(f'{model_label}名无效。')
    base_url = payload.get('base_url')
    parsed = urllib.parse.urlparse(base_url) if isinstance(base_url, str) and len(base_url) <= 500 else None
    if not parsed or parsed.scheme != 'https' or not parsed.netloc:
        raise ValueError('千问 Base URL 必须是 https:// 开头的地址。')
    return key, model, base_url


def extract_request(payload):
    """Handle /api/extract: read pasted text or an uploaded file and let the text model fill the training form."""
    key, model, base_url = _qwen_settings(payload, '文本模型')
    upload = payload.get('file')
    if upload is not None:
        if not isinstance(upload, dict) or not isinstance(upload.get('name'), str) or not isinstance(upload.get('data'), str):
            raise ValueError('上传的文件数据无效。')
        try: blob = base64.b64decode(upload['data'].split(',', 1)[-1], validate=True)
        except (ValueError, TypeError): raise ValueError('文件无法读取，请重新选择。') from None
        if len(blob) > EXTRACT_FILE_LIMIT: raise ValueError('文件请控制在 10 MB 以内。')
        text = training_extract.read_document(upload['name'], blob)
    else:
        text = payload.get('text')
        text = text.strip() if isinstance(text, str) else ''
    if not text: raise ValueError('没有可识别的文字，请粘贴培训通知或上传文件。')
    chars, truncated = len(text), len(text) > EXTRACT_MAX_CHARS
    try:
        values = training_extract.extract_training(key, model, base_url, text[:EXTRACT_MAX_CHARS])
    except urllib.error.HTTPError as exc:
        raise ValueError(http_error_message(exc, key)) from None
    except ValueError as exc:
        raise ValueError(str(exc).replace(key, '[REDACTED]')) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('无法连接文本模型服务，请检查网络后重试。') from None
    return {'values': values, 'chars': chars, 'truncated': truncated}


def validate_job_payload(payload):
    """Check a /api/jobs request and return the arguments run_job needs."""
    kind = payload.get('kind')
    if kind not in MODEL: raise ValueError('未知任务类型。')
    key = payload.get('key', '')
    key = key.strip() if isinstance(key, str) else ''
    if not key or len(key) > 512 or '\n' in key or '\r' in key: raise ValueError('请填写有效的 API key。')
    prompt = payload.get('prompt', '')
    prompt = prompt.strip() if isinstance(prompt, str) else ''
    if not prompt or len(prompt) > 16000: raise ValueError('请填写提示词（最多 16000 字）。')
    image = decode_image(payload.get('image', '')) if kind == 'split' else None
    ratio = payload.get('ratio', 'auto')
    if ratio not in RATIOS: raise ValueError('未知画面比例。')
    provider = payload.get('provider', 'maas')
    if provider not in ('maas', 'qwen'): raise ValueError('未知生图接口。')
    qwen = None
    if kind == 'generate' and provider == 'qwen':
        model = payload.get('model')
        if not isinstance(model, str) or not re.fullmatch(r'[\w.\-]{1,100}', model): raise ValueError('千问模型名无效。')
        base_url = payload.get('base_url')
        parsed = urllib.parse.urlparse(base_url) if isinstance(base_url, str) and len(base_url) <= 500 else None
        if not parsed or parsed.scheme != 'https' or not parsed.netloc:
            raise ValueError('千问 Base URL 必须是 https:// 开头的地址。')
        purpose = payload.get('purpose')
        if purpose not in PURPOSES: raise ValueError('未知创作品类。')
        refs = payload.get('references', [])
        if not isinstance(refs, list) or len(refs) > 10: raise ValueError('讲师肖像最多 10 张。')
        references = []
        for ref in refs:
            if not isinstance(ref, dict) or not isinstance(ref.get('data'), str): raise ValueError('讲师肖像数据无效。')
            references.append(decode_image(ref['data']))
        qwen = {'model': model, 'base_url': base_url, 'purpose': purpose, 'references': references}
    return {'kind': kind, 'key': key, 'prompt': prompt, 'image': image, 'ratio': ratio, 'qwen': qwen}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Do not log request bodies, credentials, or output URLs.
        pass

    def respond(self, status, body, mime='application/json; charset=utf-8'):
        if not isinstance(body, bytes): body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(body)

    def local_request(self):
        expected = f'127.0.0.1:{self.server.server_port}'
        localhost = f'localhost:{self.server.server_port}'
        if self.headers.get('Host') not in (expected, localhost): return False
        origin = self.headers.get('Origin')
        return origin is None or origin in ('http://' + expected, 'http://' + localhost)

    def do_GET(self):
        if not self.local_request(): return self.respond(403, {'error': '仅允许本地访问。'})
        path = urllib.parse.urlparse(self.path).path
        if path == '/api/health': return self.respond(200, {'ok': True})
        if path == '/api/assets': return self.respond(200, {'assets': list_assets()})
        if path == '/api/config':
            return self.respond(200, local_config())
        if path.startswith('/api/jobs/'):
            job_id = path.removeprefix('/api/jobs/')
            with LOCK: job = dict(JOBS[job_id]) if job_id in JOBS else None
            return self.respond(200 if job else 404, job or {'error': '任务不存在。'})
        base = OUTPUT if path.startswith('/output/') else STATIC
        relative = path.removeprefix('/output/') if base == OUTPUT else path.lstrip('/') or 'index.html'
        target = (base / urllib.parse.unquote(relative)).resolve()
        if not target.is_relative_to(base.resolve()) or not target.is_file():
            return self.respond(404, {'error': '文件不存在。'})
        self.respond(200, target.read_bytes(), mimetypes.guess_type(str(target))[0] or 'application/octet-stream')

    def do_POST(self):
        if not self.local_request(): return self.respond(403, {'error': '请求来源不允许。'})
        if self.path not in ('/api/jobs', '/api/extract', '/api/assets/delete', '/api/assets/restore', *EDIT_ROUTES): return self.respond(404, {'error': '接口不存在。'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > MAX_BODY: return self.respond(413, {'error': '上传内容过大，图片请控制在 20 MB 以内。'})
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict): raise ValueError('请求格式错误。')
            if self.path.startswith('/api/assets/'):
                move_asset(payload.get('id'), restore=self.path.endswith('/restore'))
                return self.respond(200, {'ok': True})
            if self.path == '/api/extract': return self.respond(200, extract_request(payload))
            if self.path in EDIT_ROUTES: return self.respond(200, EDIT_ROUTES[self.path](payload))
            job = validate_job_payload(payload)
            kind = job['kind']
            with LOCK:
                if sum(j['status'] in ('queued', 'running') for j in JOBS.values()) >= 2:
                    return self.respond(429, {'error': '已有两个任务进行中，请稍后再试。'})
                job_id = secrets.token_urlsafe(18)
                JOBS[job_id] = {'id': job_id, 'kind': kind, 'status': 'queued'}
            POOL.submit(run_job, job_id, kind, job['key'], job['prompt'], job['image'], job['ratio'], job['qwen'])
            self.respond(202, {'id': job_id})
        except (ValueError, TypeError, AttributeError, OSError) as exc:
            self.respond(400, {'error': str(exc)})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='海报工作台 V2 本地服务')
    parser.add_argument('--port', type=int, default=env_port(), help='默认读取 .env 的 PORT，未设置时为 8765')
    parser.add_argument('--open', action='store_true', help='启动后打开浏览器')
    args = parser.parse_args()
    OUTPUT.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'海报工作台 V2 已启动：http://127.0.0.1:{args.port}', flush=True)
    if args.open:
        threading.Timer(0.5, lambda: webbrowser.open(f'http://127.0.0.1:{args.port}')).start()
    try: server.serve_forever()
    except KeyboardInterrupt: server.server_close()
