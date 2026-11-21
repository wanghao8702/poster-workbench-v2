import datetime
import io
import json
import unittest
import zipfile
from unittest.mock import patch

import training_extract as tx

KEY = 'test-secret-never-save'
TODAY = datetime.date(2026, 11, 21)
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def make_docx(body):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr('word/document.xml', f'<w:document {W}><w:body>{body}</w:body></w:document>')
    return buf.getvalue()


def chat_reply(content):
    return io.BytesIO(json.dumps({'choices': [{'message': {'content': content}}]}, ensure_ascii=False).encode())


class ReadDocumentTest(unittest.TestCase):
    def test_docx_paragraphs_tables_tabs_and_breaks(self):
        blob = make_docx('<w:p><w:r><w:t>培训通知</w:t></w:r></w:p>'
                         '<w:p><w:r><w:t>时间</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">3 月 12 日</w:t></w:r></w:p>'
                         '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>讲师</w:t></w:r></w:p></w:tc>'
                         '<w:tc><w:p><w:r><w:t>明哥</w:t><w:br/><w:t>人才发展中心总监</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
        self.assertEqual(tx.read_document('通知.docx', blob), '培训通知\n时间\t3 月 12 日\n讲师\n明哥\n人才发展中心总监')

    def test_text_files_utf8_bom_and_gbk(self):
        self.assertEqual(tx.read_document('a.md', '﻿# 主题'.encode('utf-8')), '# 主题')
        self.assertEqual(tx.read_document('a.TXT', '新员工入职训练营'.encode('gbk')), '新员工入职训练营')

    def test_rejects_bad_files(self):
        with self.assertRaisesRegex(ValueError, 'docx'):
            tx.read_document('a.docx', b'not a zip')
        with self.assertRaisesRegex(ValueError, 'docx'):
            tx.read_document('a.doc', b'\xd0\xcf\x11\xe0')
        with self.assertRaisesRegex(ValueError, '支持'):
            tx.read_document('a.pdf', b'%PDF-1.7')


class NormalizeTest(unittest.TestCase):
    def test_keeps_valid_fields_and_drops_invalid(self):
        raw = {'topic': ' 新员工入职训练营 ', 'audiences': ['新员工', '实习生', '新员工'], 'date': '2027-3-5',
               'time': '9:00', 'venue': '总部 B2', 'format': '线上直播', 'headline': '', 'sub': '亮点',
               'cta': '扫码报名', 'courseList': ['企业文化', '', '制度流程'] + [f'课{i}' for i in range(10)],
               'speakers': [{'name': '明哥', 'title': '总监', 'bio': '15 年经验'}, {'name': '', 'title': '', 'bio': ''}, 'x'],
               'extra': 'ignored'}
        v = tx.normalize_training(raw)
        self.assertEqual(v['topic'], '新员工入职训练营')
        self.assertEqual(v['audiences'], ['新员工'])
        self.assertEqual(v['date'], '2027-03-05')
        self.assertEqual(v['time'], '09:00')
        self.assertEqual(v['format'], '线下')
        self.assertEqual(len(v['courseList']), 8)
        self.assertEqual(v['courseList'][:2], ['企业文化', '制度流程'])
        self.assertEqual(v['speakers'], [{'name': '明哥', 'title': '总监', 'bio': '15 年经验'}])
        self.assertNotIn('extra', v)

    def test_bad_values_become_empty(self):
        v = tx.normalize_training({'date': '下周三', 'time': '25:00', 'audiences': '管理层', 'speakers': None, 'topic': 123})
        self.assertEqual((v['date'], v['time'], v['audiences'], v['speakers'], v['topic']), ('', '', [], [], ''))
        self.assertEqual(tx.normalize_training({'format': '混合'})['format'], '混合')

    def test_lengths_capped_to_form_limits(self):
        v = tx.normalize_training({'topic': '长' * 200, 'speakers': [{'name': f'讲师{i}', 'bio': '资' * 200} for i in range(9)]})
        self.assertEqual(len(v['topic']), 80)
        self.assertEqual(len(v['speakers']), 6)
        self.assertEqual(len(v['speakers'][0]['bio']), 80)


class ExtractTest(unittest.TestCase):
    def test_request_and_parse(self):
        content = '```json\n' + json.dumps({'topic': '安全生产月', 'format': '线下', 'audiences': ['全体员工']}, ensure_ascii=False) + '\n```'
        with patch('qwen_client.urllib.request.urlopen', return_value=chat_reply(content)) as api:
            values = tx.extract_training(KEY, 'qwen-plus', 'https://dashscope.aliyuncs.com/api/v1', '通知原文', TODAY)
        req = api.call_args.args[0]
        self.assertEqual(req.full_url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
        self.assertEqual(req.get_header('Authorization'), 'Bearer ' + KEY)
        sent = json.loads(req.data)
        self.assertEqual(sent['model'], 'qwen-plus')
        self.assertEqual(sent['response_format'], {'type': 'json_object'})
        self.assertIs(sent['enable_thinking'], False)
        self.assertIn('JSON', sent['messages'][0]['content'])
        self.assertIn('2026-11-21', sent['messages'][0]['content'])
        self.assertIn('通知原文', sent['messages'][1]['content'])
        self.assertEqual(values['topic'], '安全生产月')
        self.assertEqual(values['audiences'], ['全体员工'])

    def test_chat_url(self):
        self.assertEqual(tx.chat_url('https://dashscope.aliyuncs.com/api/v1'), 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
        self.assertEqual(tx.chat_url('https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/'), 'https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions')
        self.assertEqual(tx.chat_url('https://maas.qianwenaiapi.com/compatible-mode/v1'), 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions')

    def test_unparseable_reply(self):
        with patch('qwen_client.urllib.request.urlopen', return_value=chat_reply('抱歉，我无法处理')):
            with self.assertRaisesRegex(ValueError, '识别结果无法解析'):
                tx.extract_training(KEY, 'qwen-plus', 'https://dashscope.aliyuncs.com/api/v1', '原文', TODAY)

    def test_rejects_http_base_url(self):
        with self.assertRaisesRegex(ValueError, 'https'):
            tx.extract_training(KEY, 'qwen-plus', 'http://dashscope.aliyuncs.com/api/v1', '原文', TODAY)


if __name__ == '__main__':
    unittest.main()
