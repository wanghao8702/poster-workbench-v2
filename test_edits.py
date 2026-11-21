import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import server

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=')
PNG_URL = 'data:image/png;base64,' + base64.b64encode(PNG).decode()


class EditTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name)
        self.patch = patch.object(server, 'OUTPUT', self.output)
        self.patch.start()
        self.record('rec1', 'split', ['layer-01.png', 'layer-02.png'])

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()
        server.JOBS.pop('rec1', None)

    def record(self, rid, kind, names):
        folder = self.output / rid
        folder.mkdir()
        for name in names: (folder / name).write_bytes(PNG)
        manifest = {'kind': kind, 'prompt': 'p', 'images': [{'name': n} for n in names], 'created_at': 1.0}
        (folder / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        return folder

    def doc(self, objects=None):
        return {'version': 1, 'size': {'width': 1, 'height': 1}, 'outputRatio': 'auto', 'objects': objects if objects is not None else [
            {'id': 'a', 'kind': 'split', 'name': '背景', 'source': 'layer-02.png', 'left': 0.5, 'top': 0.5, 'scaleX': 1, 'scaleY': 1,
             'angle': 0, 'opacity': 1, 'visible': True, 'locked': True},
            {'id': 'b', 'kind': 'text', 'name': '标题', 'text': '报名', 'fontFamily': '楷体', 'fontSize': 40, 'left': 1, 'top': 1}]}

    def test_import_creates_upload_record(self):
        asset = server.import_asset({'name': '我的海报.png', 'data': PNG_URL})
        folder = self.output / asset['id']
        self.assertEqual(asset['kind'], 'upload')
        self.assertEqual((folder / 'source.png').read_bytes(), PNG)
        self.assertEqual(asset['source_url'], f'/output/{asset["id"]}/source.png')
        listed = server.list_assets()
        self.assertIn(asset['id'], [a['id'] for a in listed])
        self.assertEqual([a for a in listed if a['id'] == asset['id']][0]['edited'], False)
        with self.assertRaisesRegex(ValueError, '图片格式不支持'):
            server.import_asset({'name': 'x.png', 'data': 'data:image/png;base64,bm90IGltYWdl'})

    def test_upload_into_record(self):
        result = server.edit_upload({'asset_id': 'rec1', 'data': PNG_URL})
        self.assertRegex(result['source'], r'^edit/upload-[0-9a-f]{12}\.png$')
        self.assertEqual((self.output / 'rec1' / result['source']).read_bytes(), PNG)
        self.assertEqual(result['url'], '/output/rec1/' + result['source'])
        for bad in ('../rec1', 'nope', '', None):
            with self.assertRaises(ValueError): server.edit_upload({'asset_id': bad, 'data': PNG_URL})

    def test_save_validates_and_writes_atomically(self):
        originals = {p.name: p.read_bytes() for p in (self.output / 'rec1').iterdir()}
        result = server.save_edit({'asset_id': 'rec1', 'doc': self.doc()})
        self.assertTrue(result['ok'])
        saved = json.loads((self.output / 'rec1/edit/edit.json').read_text(encoding='utf-8'))
        self.assertEqual([o['id'] for o in saved['objects']], ['a', 'b'])
        self.assertEqual(saved['objects'][1]['text'], '报名')
        self.assertEqual(list((self.output / 'rec1/edit').glob('*.tmp')), [])
        for name, blob in originals.items():
            self.assertEqual((self.output / 'rec1' / name).read_bytes(), blob, '模型原始输出不得改动')
        asset = [a for a in server.list_assets() if a['id'] == 'rec1'][0]
        self.assertEqual((asset['edited'], asset['edit_url']), (True, '/output/rec1/edit/edit.json'))
        self.assertGreater(asset['edited_at'], 0)

    def test_save_rejects_bad_docs(self):
        bad_objects = [
            [{'id': 'x', 'kind': 'script', 'left': 0, 'top': 0}],
            [{'id': 'x', 'kind': 'image', 'source': '../rec2/layer-01.png'}],
            [{'id': 'x', 'kind': 'image', 'source': 'edit/upload-missing.png'}],
            [{'id': 'x', 'kind': 'split', 'source': 'manifest.json'}],
        ]
        for objects in bad_objects:
            with self.assertRaises(ValueError, msg=objects): server.save_edit({'asset_id': 'rec1', 'doc': self.doc(objects)})
        with self.assertRaisesRegex(ValueError, '版本'): server.save_edit({'asset_id': 'rec1', 'doc': {**self.doc(), 'version': 2}})
        with self.assertRaisesRegex(ValueError, '过大'):
            server.save_edit({'asset_id': 'rec1', 'doc': self.doc([{'id': f'x{i}', 'kind': 'text', 'text': '字' * 4000} for i in range(200)])})
        with self.assertRaises(ValueError): server.save_edit({'asset_id': 'rec1', 'doc': self.doc([{'id': f'x{i}', 'kind': 'shape'} for i in range(201)])})
        server.JOBS['rec1'] = {'status': 'running'}
        with self.assertRaisesRegex(ValueError, '处理中'): server.save_edit({'asset_id': 'rec1', 'doc': self.doc()})

    def test_save_drops_unknown_fields_and_bad_numbers(self):
        objects = [{'id': 'b', 'kind': 'text', 'text': 'x' * 3000, 'left': float('nan'), 'top': 'oops', 'onload': 'alert(1)', 'fontSize': 1e9}]
        server.save_edit({'asset_id': 'rec1', 'doc': self.doc(objects)})
        saved = json.loads((self.output / 'rec1/edit/edit.json').read_text(encoding='utf-8'))['objects'][0]
        self.assertNotIn('onload', saved)
        self.assertNotIn('left', saved)
        self.assertNotIn('top', saved)
        self.assertEqual(len(saved['text']), 2000)
        self.assertEqual(saved['fontSize'], 1000)

    def test_reset_moves_edit_to_trash(self):
        server.save_edit({'asset_id': 'rec1', 'doc': self.doc()})
        server.reset_edit({'asset_id': 'rec1'})
        self.assertFalse((self.output / 'rec1/edit').exists())
        trashed = list((self.output / '.trash').glob('rec1-edit-*/edit.json'))
        self.assertEqual(len(trashed), 1)
        self.assertFalse([a for a in server.list_assets() if a['id'] == 'rec1'][0]['edited'])
        server.reset_edit({'asset_id': 'rec1'})  # nothing to reset is fine

    def test_carry_copies_uploads(self):
        self.record('rec2', 'split', ['layer-01.png'])
        up = server.edit_upload({'asset_id': 'rec1', 'data': PNG_URL})['source']
        result = server.carry_edit({'from': 'rec1', 'to': 'rec2', 'sources': [up]})
        new = result['sources'][up]
        self.assertRegex(new, r'^edit/upload-[0-9a-f]{12}\.png$')
        self.assertEqual((self.output / 'rec2' / new).read_bytes(), PNG)
        with self.assertRaises(ValueError): server.carry_edit({'from': 'rec1', 'to': 'rec2', 'sources': ['layer-01.png']})
        with self.assertRaises(ValueError): server.carry_edit({'from': 'rec1', 'to': 'rec2', 'sources': ['edit/../../x.png']})

    def test_legacy_records_still_list(self):
        assets = server.list_assets()
        self.assertEqual(assets[0]['id'], 'rec1')
        self.assertFalse(assets[0]['edited'])
        self.assertIsNone(assets[0]['edit_url'])


if __name__ == '__main__':
    unittest.main()
