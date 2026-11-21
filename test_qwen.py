import base64
import io
import json
import unittest
from unittest.mock import patch

import qwen_client

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=')
KEY = 'test-secret-never-save'
DASH = 'https://dashscope.aliyuncs.com/api/v1'
COMPAT = 'https://maas.qianwenaiapi.com/compatible-mode/v1'


def body(obj):
    return io.BytesIO(json.dumps(obj).encode())


def dash_reply(url='https://oss.example/x.png'):
    return body({'output': {'choices': [{'message': {'content': [{'image': url}]}}]}})


class QwenClientTest(unittest.TestCase):
    def test_detect_protocol(self):
        d = qwen_client.detect_protocol
        self.assertEqual(d('qwen-image-3.0-pro', DASH), 'dashscope')
        self.assertEqual(d('qwen-image-3.0-pro', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), 'dashscope')
        self.assertEqual(d('qwen-image-3.0-pro', COMPAT), 'qwen')
        self.assertEqual(d('qwen-image-plus', 'https://example.com/v1'), 'qwen')
        self.assertEqual(d('gpt-image-1', 'https://api.openai.com/v1'), 'openai')

    def test_dashscope_origin(self):
        self.assertEqual(qwen_client.dashscope_origin('https://ws-1.cn-beijing.aliyuncs.com/api/v1/x'), 'https://ws-1.cn-beijing.aliyuncs.com')
        self.assertEqual(qwen_client.dashscope_origin(''), 'https://dashscope.aliyuncs.com')

    def test_limits_and_sizes(self):
        self.assertEqual(qwen_client.max_ref_images('qwen-image-2.1-pro'), 10)
        self.assertEqual(qwen_client.max_ref_images('qwen-image-3.0-pro'), 3)
        self.assertEqual(qwen_client.qwen_size('3:4', 'cover'), (1140, 1472))
        self.assertEqual(qwen_client.qwen_size('5:2', 'cover'), (1664, 928))
        self.assertEqual(qwen_client.qwen_size('auto', 'training'), (1140, 1472))
        self.assertEqual(qwen_client.qwen_size('auto', 'cover'), (1664, 928))
        self.assertEqual(qwen_client.qwen_size('auto', 'free'), (1328, 1328))

    def test_dashscope_request_body_and_download(self):
        with patch('qwen_client.urllib.request.urlopen', side_effect=[dash_reply(), io.BytesIO(PNG)]) as api:
            images, warnings = qwen_client.request_image(KEY, 'qwen-image-3.0-pro', DASH, '提示词', (1140, 1472), [PNG])
        req = api.call_args_list[0].args[0]
        self.assertEqual(req.full_url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
        self.assertEqual(req.get_header('Authorization'), 'Bearer ' + KEY)
        sent = json.loads(req.data)
        self.assertEqual(sent['model'], 'qwen-image-3.0-pro')
        self.assertEqual(sent['parameters'], {'size': '1140*1472', 'n': 1, 'prompt_extend': False, 'watermark': False})
        content = sent['input']['messages'][0]['content']
        self.assertEqual(content[0], {'text': '提示词'})
        self.assertTrue(content[1]['image'].startswith('data:image/png;base64,'))
        self.assertEqual(api.call_args_list[1].args[0], 'https://oss.example/x.png')
        self.assertEqual(images, [PNG])
        self.assertEqual(warnings, [])

    def test_dashscope_200_with_code_is_error(self):
        with patch('qwen_client.urllib.request.urlopen', return_value=body({'code': 'InvalidParameter', 'message': 'size invalid'})):
            with self.assertRaisesRegex(ValueError, 'size invalid'):
                qwen_client.request_image(KEY, 'qwen-image-3.0-pro', DASH, '提示词', (1140, 1472), [])

    def test_compatible_request_body(self):
        reply = body({'data': [{'b64_json': base64.b64encode(PNG).decode()}]})
        with patch('qwen_client.urllib.request.urlopen', return_value=reply) as api:
            images, _ = qwen_client.request_image(KEY, 'qwen-image-plus', COMPAT, '提示词', (1140, 1472), [PNG])
        req = api.call_args.args[0]
        self.assertEqual(req.full_url, COMPAT + '/images/generations')
        sent = json.loads(req.data)
        self.assertEqual(sent, {'model': 'qwen-image-plus', 'prompt': '提示词', 'size': '1140x1472', 'n': 1,
                                'prompt_extend': False, 'image': ['data:image/png;base64,' + base64.b64encode(PNG).decode()]})
        self.assertEqual(images, [PNG])

    def test_compatible_without_refs_has_no_image_key(self):
        reply = body({'data': [{'b64_json': base64.b64encode(PNG).decode()}]})
        with patch('qwen_client.urllib.request.urlopen', return_value=reply) as api:
            qwen_client.request_image(KEY, 'qwen-image-plus', COMPAT, '提示词', (1328, 1328), [])
        self.assertNotIn('image', json.loads(api.call_args.args[0].data))

    def test_truncates_refs_with_warning(self):
        with patch('qwen_client.urllib.request.urlopen', side_effect=[dash_reply(), io.BytesIO(PNG)]) as api:
            _, warnings = qwen_client.request_image(KEY, 'qwen-image-3.0-pro', DASH, '提示词', (1140, 1472), [PNG] * 4)
        content = json.loads(api.call_args_list[0].args[0].data)['input']['messages'][0]['content']
        self.assertEqual(sum('image' in part for part in content), 3)
        self.assertEqual(warnings, ['参考图超过模型上限 3 张，已舍弃 1 张讲师肖像。'])

    def test_download_rejects_non_https(self):
        with patch('qwen_client.urllib.request.urlopen', return_value=dash_reply('http://oss.example/x.png')):
            with self.assertRaisesRegex(ValueError, '服务返回了不支持的图片地址。'):
                qwen_client.request_image(KEY, 'qwen-image-3.0-pro', DASH, '提示词', (1140, 1472), [])

    def test_openai_protocol_rejected(self):
        with self.assertRaisesRegex(ValueError, '仅支持千问'):
            qwen_client.request_image(KEY, 'gpt-image-1', 'https://api.openai.com/v1', '提示词', (1024, 1024), [])

    def test_rejects_http_base_url(self):
        with self.assertRaisesRegex(ValueError, 'https'):
            qwen_client.request_image(KEY, 'qwen-image-3.0-pro', 'http://dashscope.aliyuncs.com/api/v1', '提示词', (1140, 1472), [])


if __name__ == '__main__':
    unittest.main()
