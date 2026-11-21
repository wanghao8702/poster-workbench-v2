"""Read a training notice (txt / md / docx) and let a Qwen text model fill the training poster form.

Python standard library only. The model is asked for JSON; normalize_training() then clamps the
result to exactly what the form accepts, so a sloppy reply can never put invalid values in the form.
"""
import datetime
import io
import json
import re
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET

import qwen_client

AUDIENCES = ['新员工', '管理层', '技术人员', '销售团队', '全体员工', '客户与合作方']
FORMATS = ['线下', '线上', '混合']
MAX_SPEAKERS, MAX_COURSES = 6, 8
LIMITS = {'topic': 80, 'venue': 80, 'headline': 40, 'sub': 60, 'cta': 40, 'course': 40,
          'name': 20, 'title': 40, 'bio': 80}
DOCX_XML_LIMIT = 20 * 1024 * 1024
WORD_NS = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


# ---------- documents ----------
def _docx_text(blob):
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            info = archive.getinfo('word/document.xml')
            if info.file_size > DOCX_XML_LIMIT: raise ValueError('Word 文档内容过大，请删减后再试。')
            root = ET.fromstring(archive.read(info))
    except (zipfile.BadZipFile, KeyError, ET.ParseError):
        raise ValueError('文件不是有效的 Word（.docx）文档，请另存为 .docx 或直接粘贴文字。') from None
    lines = []
    for paragraph in root.iter(WORD_NS + 'p'):
        parts = []
        for node in paragraph.iter():
            if node.tag == WORD_NS + 't': parts.append(node.text or '')
            elif node.tag == WORD_NS + 'tab': parts.append('\t')
            elif node.tag in (WORD_NS + 'br', WORD_NS + 'cr'): parts.append('\n')
        line = ''.join(parts).strip()
        if line: lines.append(line)
    return '\n'.join(lines)


def _plain_text(blob):
    for encoding in ('utf-8-sig', 'gb18030'):
        try: return blob.decode(encoding)
        except UnicodeDecodeError: continue
    raise ValueError('文本文件编码无法识别，请另存为 UTF-8 后再试。')


def read_document(name, blob):
    """Return the text of an uploaded .txt / .md / .docx file."""
    ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    if ext in ('txt', 'md', 'markdown'): return _plain_text(blob).strip()
    if ext == 'docx': return _docx_text(blob).strip()
    if ext == 'doc': raise ValueError('不支持旧版 .doc，请在 Word 中另存为 .docx，或直接粘贴文字。')
    raise ValueError('只支持 .txt、.md、.docx 文件，PDF 等其他格式请复制文字粘贴进来。')


# ---------- normalisation ----------
def _text(value, limit):
    return value.strip()[:limit] if isinstance(value, str) else ''


def _date(value):
    match = re.fullmatch(r'(\d{4})-(\d{1,2})-(\d{1,2})', _text(value, 20))
    if not match: return ''
    try: return datetime.date(*map(int, match.groups())).isoformat()
    except ValueError: return ''


def _time(value):
    match = re.fullmatch(r'(\d{1,2}):(\d{2})', _text(value, 10))
    if not match or int(match[1]) > 23 or int(match[2]) > 59: return ''
    return f'{int(match[1]):02d}:{match[2]}'


def normalize_training(raw):
    """Clamp a model reply to the training form's fields, types, options and length limits."""
    raw = raw if isinstance(raw, dict) else {}
    audiences = raw.get('audiences') if isinstance(raw.get('audiences'), list) else []
    courses = raw.get('courseList') if isinstance(raw.get('courseList'), list) else []
    speakers = raw.get('speakers') if isinstance(raw.get('speakers'), list) else []
    fmt = _text(raw.get('format'), 10)
    people = []
    for item in speakers:
        if not isinstance(item, dict): continue
        person = {key: _text(item.get(key), LIMITS[key]) for key in ('name', 'title', 'bio')}
        if any(person.values()): people.append(person)
    return {
        'topic': _text(raw.get('topic'), LIMITS['topic']),
        'audiences': [a for a in AUDIENCES if a in audiences],
        'date': _date(raw.get('date')),
        'time': _time(raw.get('time')),
        'venue': _text(raw.get('venue'), LIMITS['venue']),
        'format': fmt if fmt in FORMATS else '线下',
        'headline': _text(raw.get('headline'), LIMITS['headline']),
        'sub': _text(raw.get('sub'), LIMITS['sub']),
        'cta': _text(raw.get('cta'), LIMITS['cta']),
        'courseList': [c for c in (_text(c, LIMITS['course']) for c in courses) if c][:MAX_COURSES],
        'speakers': people[:MAX_SPEAKERS],
    }


# ---------- model call ----------
def chat_url(base_url):
    """OpenAI-compatible chat endpoint on the same Bailian host as the image Base URL."""
    base = base_url.strip().rstrip('/')
    match = re.search(r'^(.*?/compatible-mode/v1)', base)
    if match: return match.group(1) + '/chat/completions'
    return qwen_client.dashscope_origin(base) + '/compatible-mode/v1/chat/completions'


def _system_prompt(today):
    return f"""你是企业培训海报的信息提取助手。从用户提供的培训通知、方案或课程介绍中，提取制作宣传海报需要的信息，只输出一个 JSON 对象，不要输出任何解释。

今天是 {today.isoformat()}。

JSON 字段：
{{
  "topic": "培训主题 / 项目名称，原文怎么写就怎么写",
  "audiences": ["只能从这些选项中选择：{'、'.join(AUDIENCES)}；原文明确提到对应人群才选，没有就给空数组"],
  "date": "开始日期，格式 YYYY-MM-DD；原文只写了月日时，取今天之后最近的那一天；没有就给空字符串",
  "time": "开始时间，24 小时制 HH:MM；写了时间段时取开始时间；没有就给空字符串",
  "venue": "地点或线上平台名称",
  "format": "线下、线上、混合 三选一；只有线上平台（如腾讯会议、钉钉直播）为线上，同时有现场和线上为混合",
  "headline": "原文中的主标题、口号或宣传语；没有就给空字符串",
  "sub": "一句话亮点，30 字以内，可依据原文概括",
  "cta": "报名方式或截止时间，20 字以内，例如「3 月 5 日前完成报名」；原文没有就给空字符串",
  "courseList": ["3 到 6 条课程要点，每条 16 字以内，依据原文的课程模块或议程提炼"],
  "speakers": [{{"name": "讲师姓名", "title": "职务或头衔", "bio": "资历简介，40 字以内"}}]
}}

规则：
- 原文没有的信息一律留空（空字符串或空数组），不要编造日期、地点、讲师、头衔或资历。
- 不要把学员、主持人或组织方联系人当作讲师。
- 所有文字使用简体中文，去掉多余空格和序号。"""


def _parse_json(content):
    text = content.strip() if isinstance(content, str) else ''
    fenced = re.search(r'```(?:json)?\s*(.*?)```', text, re.S)
    if fenced: text = fenced.group(1).strip()
    try: data = json.loads(text)
    except ValueError: data = None
    if not isinstance(data, dict): raise ValueError('识别结果无法解析，请重试，或换一个文本模型。')
    return data


def extract_training(key, model, base_url, text, today=None):
    """Ask the text model for the form fields. HTTPError propagates; other failures raise ValueError."""
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != 'https' or not parsed.netloc: raise ValueError('千问 Base URL 必须以 https:// 开头。')
    today = today or datetime.date.today()
    data = qwen_client._post(chat_url(base_url), key, {
        'model': model,
        'messages': [{'role': 'system', 'content': _system_prompt(today)},
                     {'role': 'user', 'content': '以下是培训资料原文：\n\n' + text}],
        'response_format': {'type': 'json_object'},
        'enable_thinking': False,
        'temperature': 0.1,
    })
    try: content = data['choices'][0]['message']['content']
    except (KeyError, IndexError, TypeError): content = ''
    return normalize_training(_parse_json(content))
