import base64
from email.parser import BytesParser
from email.policy import default
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock
import urllib.error
import zipfile
import server

# A valid 1 × 1 transparent PNG.
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=')
KEY = 'test-secret-never-save'

class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name)
        self.patch = patch.object(server, 'OUTPUT', self.output)
        self.patch.start()
        server.JOBS['test'] = {'status': 'queued'}

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()
        server.JOBS.pop('test', None)

    def reply(self, count=1):
        return io.BytesIO(json.dumps({'data': [{'b64_json': base64.b64encode(PNG).decode()} for _ in range(count)], 'usage': {'total_tokens': 5}}).encode())

    def test_generation_exports_real_images_and_no_key(self):
        with patch('server.urllib.request.urlopen', return_value=self.reply()) as api:
            server.run_job('test', 'generate', KEY, '测试海报', None)
        req = api.call_args.args[0]
        self.assertTrue(req.full_url.endswith('/images/generations'))
        self.assertEqual(json.loads(req.data)['model'], server.MODEL['generate'])
        self.assertEqual(server.JOBS['test']['status'], 'done')
        self.assertEqual((self.output/'test/image-01.png').read_bytes(), PNG)
        with zipfile.ZipFile(self.output/'test/images.zip') as archive:
            self.assertEqual(archive.read('image-01.png'), PNG)
            self.assertNotIn(KEY, archive.read('manifest.json').decode())
        self.assertNotIn(KEY, json.dumps(server.JOBS['test']))

    def config_response(self):
        handler = object.__new__(server.Handler)
        handler.path = '/api/config'
        handler.local_request = lambda: True
        handler.respond = Mock()
        handler.do_GET()
        status, body = handler.respond.call_args.args
        self.assertEqual(status, 200)
        return body

    def patch_files(self, env=None, maas=None, qwen=None):
        files = {'.env': env, '.local-key': maas, '.local-qwen-key': qwen}
        for name, text in files.items():
            if text is not None: (self.output / name).write_text(text, encoding='utf-8')
        stack = [patch.object(server, 'ENV_FILE', self.output / '.env'), patch.object(server, 'KEY_FILE', self.output / '.local-key'),
                 patch.object(server, 'QWEN_KEY_FILE', self.output / '.local-qwen-key')]
        for p in stack: p.start(); self.addCleanup(p.stop)

    def test_load_env_parses_comments_quotes_and_bom(self):
        path = self.output / '.env'
        path.write_text('\ufeff# 注释\nQWEN_API_KEY = sk-abc \nexport MAAS_API_KEY="m k"\nQWEN_TEXT_MODEL=\'qwen-flash\'\nBAD LINE\nEMPTY=\nURL=https://a/b#frag # 行尾注释\n', encoding='utf-8')
        self.assertEqual(server.load_env(path), {'QWEN_API_KEY': 'sk-abc', 'MAAS_API_KEY': 'm k', 'QWEN_TEXT_MODEL': 'qwen-flash', 'EMPTY': '', 'URL': 'https://a/b#frag'})
        self.assertEqual(server.load_env(self.output / 'missing.env'), {})

    def test_config_reads_env(self):
        self.patch_files(env='MAAS_API_KEY=m1\nQWEN_API_KEY=q1\nGEN_PROVIDER=maas\nQWEN_IMAGE_MODEL=qwen-image-2.1-pro\n'
                             'QWEN_TEXT_MODEL=qwen-flash\nQWEN_BASE_URL=https://ws1.cn-beijing.maas.aliyuncs.com/api/v1\n')
        self.assertEqual(self.config_response(), {'runtime': 'local', 'source': '.env', 'default_key': 'm1', 'default_qwen_key': 'q1',
            'gen_provider': 'maas', 'qwen_image_model': 'qwen-image-2.1-pro', 'qwen_text_model': 'qwen-flash',
            'qwen_base_url': 'https://ws1.cn-beijing.maas.aliyuncs.com/api/v1'})

    def test_config_falls_back_to_legacy_key_files(self):
        self.patch_files(env='QWEN_API_KEY=\n', maas=KEY + '\n', qwen='q-old')
        body = self.config_response()
        self.assertEqual((body['default_key'], body['default_qwen_key'], body['source']), (KEY, 'q-old', '.local-key'))
        self.assertEqual((body['gen_provider'], body['qwen_image_model'], body['qwen_text_model'], body['qwen_base_url']), ('', '', '', ''))

    def test_config_drops_invalid_settings(self):
        self.patch_files(env='GEN_PROVIDER=openai\nQWEN_IMAGE_MODEL=a b\nQWEN_BASE_URL=http://x\nMAAS_API_KEY=' + 'x' * 600 + '\n')
        body = self.config_response()
        self.assertEqual((body['gen_provider'], body['qwen_image_model'], body['qwen_base_url'], body['source']), ('', '', '', ''))

    def test_env_port(self):
        self.patch_files(env='PORT=8790\n')
        self.assertEqual(server.env_port(), 8790)
        (self.output / '.env').write_text('PORT=abc\n', encoding='utf-8')
        self.assertEqual(server.env_port(), 8765)

    def test_split_multipart_has_original_image_and_exports_all_layers(self):
        with patch('server.urllib.request.urlopen', return_value=self.reply(2)) as api:
            server.run_job('test', 'split', KEY, '拆成两层', PNG)
        req = api.call_args.args[0]
        message = BytesParser(policy=default).parsebytes(('Content-Type: '+req.get_header('Content-type')+'\r\n\r\n').encode()+req.data)
        fields = {p.get_param('name', header='content-disposition'):p.get_payload(decode=True) for p in message.iter_parts()}
        self.assertTrue(req.full_url.endswith('/images/edits'))
        self.assertEqual(fields['image'], PNG)
        self.assertEqual(fields['prompt'].decode(), '拆成两层')
        self.assertEqual(len(server.JOBS['test']['images']), 2)

    def test_api_error_redacts_credential(self):
        error = urllib.error.HTTPError(server.API, 401, 'Unauthorized', {}, io.BytesIO(json.dumps({'error': {'message': KEY}}).encode()))
        with patch('server.urllib.request.urlopen', side_effect=error):
            server.run_job('test','generate',KEY,'测试',None)
        self.assertEqual(server.JOBS['test']['status'],'error')
        self.assertNotIn(KEY,server.JOBS['test']['error'])

    def test_upload_rejects_invalid_and_oversized_images(self):
        with self.assertRaises(ValueError): server.decode_image('data:image/png;base64,not-a-picture')
        with self.assertRaises(ValueError): server.decode_image(base64.b64encode(PNG+b'x'*(20*1024*1024)).decode())

    def test_history_reads_completed_jobs_and_keeps_split_source(self):
        with patch('server.urllib.request.urlopen', return_value=self.reply(2)):
            server.run_job('test', 'split', KEY, '历史拆层', PNG)
        assets = server.list_assets()
        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]['kind'], 'split')
        self.assertEqual(len(assets[0]['images']), 2)
        self.assertEqual(assets[0]['source_url'], '/output/test/source.png')
        self.assertEqual((self.output/'test/source.png').read_bytes(), PNG)
        self.assertNotIn(KEY, json.dumps(assets))
        server.JOBS.pop('test')
        self.assertEqual(len(server.list_assets()), 1)

    def test_history_supports_old_records_and_skips_invalid_files(self):
        old = self.output/'old'
        old.mkdir()
        (old/'image-01.png').write_bytes(PNG)
        (old/'manifest.json').write_text(json.dumps({'kind':'generate','prompt':'旧图片','images':[{'name':'image-01.png'},{'name':'../outside.png'}]}), encoding='utf-8')
        bad = self.output/'bad'
        bad.mkdir()
        (bad/'manifest.json').write_text('{incomplete')
        assets = server.list_assets()
        self.assertEqual(len(assets),1)
        self.assertEqual(assets[0]['images'],[{'name':'image-01.png','url':'/output/old/image-01.png'}])
        self.assertIsNone(assets[0]['source_url'])

    def test_asset_delete_and_restore_preserve_files(self):
        with patch('server.urllib.request.urlopen', return_value=self.reply()):
            server.run_job('test','generate',KEY,'删除测试',None)
        server.move_asset('test')
        self.assertEqual(server.list_assets(), [])
        self.assertEqual((self.output/'.trash/test/image-01.png').read_bytes(),PNG)
        server.move_asset('test',restore=True)
        self.assertEqual(len(server.list_assets()),1)
        self.assertEqual((self.output/'test/image-01.png').read_bytes(),PNG)
        for invalid in ('../test','test/other','',None):
            with self.assertRaises(ValueError): server.move_asset(invalid)
        server.JOBS['test']['status']='running'
        with self.assertRaises(ValueError): server.move_asset('test')

    QWEN = {'model': 'qwen-image-3.0-pro', 'base_url': 'https://dashscope.aliyuncs.com/api/v1', 'purpose': 'training'}

    def test_qwen_generation_saves_provider_and_refs(self):
        with patch('server.qwen_client.request_image', return_value=([PNG], ['w1'])) as api:
            server.run_job('test', 'generate', KEY, '培训海报', None, '3:4', {**self.QWEN, 'references': [PNG]})
        args = api.call_args.args
        self.assertEqual(args[0], KEY)
        self.assertEqual(args[4], (1140, 1472))
        self.assertEqual(args[5], [PNG])
        job = server.JOBS['test']
        self.assertEqual(job['status'], 'done', job.get('error'))
        self.assertEqual(job['warnings'], ['w1'])
        manifest = json.loads((self.output/'test/manifest.json').read_text(encoding='utf-8'))
        self.assertEqual((manifest['provider'], manifest['model'], manifest['warnings']), ('qwen', 'qwen-image-3.0-pro', ['w1']))
        self.assertEqual((self.output/'test/ref-01.png').read_bytes(), PNG)
        with zipfile.ZipFile(self.output/'test/images.zip') as archive:
            self.assertNotIn('ref-01.png', archive.namelist())
        for name in ('manifest.json', 'prompt.txt'):
            self.assertNotIn(KEY, (self.output/'test'/name).read_text(encoding='utf-8'))
        self.assertEqual(server.list_assets()[0]['model'], 'qwen-image-3.0-pro')

    def test_maas_generation_records_provider(self):
        with patch('server.urllib.request.urlopen', return_value=self.reply()):
            server.run_job('test', 'generate', KEY, '测试', None)
        manifest = json.loads((self.output/'test/manifest.json').read_text(encoding='utf-8'))
        self.assertEqual((manifest['provider'], manifest['model'], manifest['warnings']), ('maas', server.MODEL['generate'], []))
        self.assertEqual(server.JOBS['test']['warnings'], [])

    def test_qwen_error_redacts_key(self):
        error = urllib.error.HTTPError('https://dashscope.aliyuncs.com', 401, 'Unauthorized', {}, io.BytesIO(json.dumps({'message': f'bad key {KEY}'}).encode()))
        with patch('server.qwen_client.request_image', side_effect=error):
            server.run_job('test', 'generate', KEY, '测试', None, '3:4', {**self.QWEN, 'references': []})
        job = server.JOBS['test']
        self.assertEqual(job['status'], 'error')
        self.assertIn('HTTP 401', job['error'])
        self.assertNotIn(KEY, job['error'])
        self.assertIn('[REDACTED]', job['error'])

    def test_qwen_value_error_redacts_key(self):
        with patch('server.qwen_client.request_image', side_effect=ValueError(f'echo {KEY}')):
            server.run_job('test', 'generate', KEY, '测试', None, '3:4', {**self.QWEN, 'references': []})
        self.assertNotIn(KEY, server.JOBS['test']['error'])

    def test_maas_image_download_failure_message(self):
        reply = io.BytesIO(json.dumps({'data': [{'url': 'https://oss.example/x.png'}]}).encode())
        expired = urllib.error.HTTPError('https://oss.example/x.png', 403, 'Forbidden', {}, io.BytesIO(b'expired'))
        # server and qwen_client share the urllib.request module: first call is MaaS, second the image download.
        with patch('server.urllib.request.urlopen', side_effect=[reply, expired]):
            server.run_job('test', 'generate', KEY, '测试', None)
        error = server.JOBS['test']['error']
        self.assertIn('结果图片下载失败', error)
        self.assertNotIn('API key', error)

    def test_split_still_uses_maas(self):
        with patch('server.urllib.request.urlopen', return_value=self.reply(2)) as api:
            server.run_job('test', 'split', KEY, '拆层', PNG)
        self.assertEqual(api.call_args.args[0].full_url, 'https://maas-api.antdigital.com/v1/images/edits')

    def test_lists_legacy_manifest(self):
        old = self.output/'legacy'
        old.mkdir()
        (old/'image-01.png').write_bytes(PNG)
        (old/'manifest.json').write_text(json.dumps({'kind': 'generate', 'prompt': '旧', 'images': [{'name': 'image-01.png'}]}), encoding='utf-8')
        assets = server.list_assets()
        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]['model'], server.MODEL['generate'])

    def payload(self, **extra):
        data = {'kind': 'generate', 'key': KEY, 'prompt': '海报', 'ratio': '3:4', 'provider': 'qwen',
                'model': 'qwen-image-3.0-pro', 'base_url': 'https://dashscope.aliyuncs.com/api/v1', 'purpose': 'training',
                'references': [{'name': 'a.png', 'data': 'data:image/png;base64,' + base64.b64encode(PNG).decode()}]}
        data.update(extra)
        return data

    def test_validate_qwen_payload(self):
        job = server.validate_job_payload(self.payload())
        self.assertEqual(job['kind'], 'generate')
        self.assertEqual(job['qwen'], {'model': 'qwen-image-3.0-pro', 'base_url': 'https://dashscope.aliyuncs.com/api/v1',
                                       'purpose': 'training', 'references': [PNG]})
        maas = server.validate_job_payload({'kind': 'generate', 'key': KEY, 'prompt': '海报', 'ratio': '3:4'})
        self.assertIsNone(maas['qwen'])

    def test_rejects_bad_reference(self):
        bad = [{'name': 'a.png', 'data': 'data:image/png;base64,bm90IGltYWdl'}]
        with self.assertRaisesRegex(ValueError, '图片格式不支持'): server.validate_job_payload(self.payload(references=bad))
        with self.assertRaises(ValueError): server.validate_job_payload(self.payload(references=self.payload()['references'] * 11))
        with self.assertRaisesRegex(ValueError, 'https'): server.validate_job_payload(self.payload(base_url='http://x'))
        with self.assertRaises(ValueError): server.validate_job_payload(self.payload(purpose='xhs'))
        with self.assertRaises(ValueError): server.validate_job_payload(self.payload(model='a b'))
        with self.assertRaises(ValueError): server.validate_job_payload(self.payload(provider='openai'))
        with self.assertRaises(ValueError): server.validate_job_payload(self.payload(references='x'))


    def extract_payload(self, **extra):
        data = {'key': KEY, 'model': 'qwen-plus', 'base_url': 'https://dashscope.aliyuncs.com/api/v1', 'text': '安全生产月培训通知'}
        data.update(extra)
        return data

    def test_extract_from_text(self):
        with patch('server.training_extract.extract_training', return_value={'topic': '安全生产月'}) as api:
            result = server.extract_request(self.extract_payload())
        self.assertEqual(result, {'values': {'topic': '安全生产月'}, 'chars': 9, 'truncated': False})
        self.assertEqual(api.call_args.args[:4], (KEY, 'qwen-plus', 'https://dashscope.aliyuncs.com/api/v1', '安全生产月培训通知'))

    def test_extract_from_gbk_txt_file_and_truncates(self):
        long_text = '培训' * 15000
        data = 'data:text/plain;base64,' + base64.b64encode(long_text.encode('gbk')).decode()
        with patch('server.training_extract.extract_training', return_value={}) as api:
            result = server.extract_request(self.extract_payload(text=None, file={'name': '通知.txt', 'data': data}))
        self.assertTrue(result['truncated'])
        self.assertEqual(result['chars'], 30000)
        self.assertEqual(len(api.call_args.args[3]), server.EXTRACT_MAX_CHARS)

    def test_extract_validation(self):
        with self.assertRaisesRegex(ValueError, '没有可识别'): server.extract_request(self.extract_payload(text='   '))
        with self.assertRaisesRegex(ValueError, 'https'): server.extract_request(self.extract_payload(base_url='http://x'))
        with self.assertRaises(ValueError): server.extract_request(self.extract_payload(model='a b'))
        with self.assertRaisesRegex(ValueError, 'API Key'): server.extract_request(self.extract_payload(key=''))
        with self.assertRaisesRegex(ValueError, '支持'): server.extract_request(self.extract_payload(text=None, file={'name': 'a.pdf', 'data': 'JVBERi0='}))
        with self.assertRaises(ValueError): server.extract_request(self.extract_payload(text=None, file={'name': 'a.txt', 'data': '%%%'}))

    def test_extract_http_error_redacts_key(self):
        error = urllib.error.HTTPError('https://dashscope.aliyuncs.com', 401, 'Unauthorized', {}, io.BytesIO(json.dumps({'error': {'message': f'bad {KEY}'}}).encode()))
        with patch('server.training_extract.extract_training', side_effect=error):
            with self.assertRaises(ValueError) as caught:
                server.extract_request(self.extract_payload())
        self.assertIn('HTTP 401', str(caught.exception))
        self.assertNotIn(KEY, str(caught.exception))

if __name__ == '__main__': unittest.main()
