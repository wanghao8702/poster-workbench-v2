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

    def test_local_configuration_loads_test_key(self):
        handler = object.__new__(server.Handler)
        handler.path = '/api/config'
        handler.local_request = lambda: True
        handler.respond = Mock()
        with patch.object(Path, 'is_file', return_value=True), patch.object(Path, 'read_text', return_value=KEY):
            handler.do_GET()
        handler.respond.assert_called_once_with(200, {'runtime': 'local', 'default_key': KEY, 'default_qwen_key': KEY})

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


if __name__ == '__main__': unittest.main()
