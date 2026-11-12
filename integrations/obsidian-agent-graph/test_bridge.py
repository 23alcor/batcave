import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
VAULT = Path(os.environ.get('BAT_VAULT', Path.home() / 'Documents' / 'Bat Vault'))
spec = importlib.util.spec_from_file_location('bridge', VAULT / '.tools/batcave-bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class ContextFiling(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'Project.md').write_text('---\ntype: project\n---\n# Human project\nKeep this.\n')
        self.item = dict(id='12345678-1234-1234-1234-123456789abc', revision=1, project='Project', project_path='Project.md',
                         file_path='Agent Context/Task - 12345678.md', task='Retrieval', entry_note='Project.md', content='Progress', next_action='Next', updated_at='2026-11-09T17:00:00Z')
        self.acks = []

    def run_bridge(self, dry=False):
        def call(cfg, method, path, body=None):
            if method == 'GET':
                return {'contexts': [self.item]}
            self.acks.append(body)
            return {'ok': True}
        with patch.object(bridge, 'call', call):
            bridge.file_contexts({}, str(self.root), dry)

    def test_revisions_and_retry(self):
        original = (self.root / 'Project.md').read_bytes()
        self.run_bridge()
        path = self.root / self.item['file_path']
        self.assertIn('revision: 1', path.read_text())
        self.item.update(revision=2, content='Newer progress')
        self.run_bridge()
        self.item.update(revision=1, content='Stale progress')
        self.run_bridge()
        self.assertIn('Newer progress', path.read_text())
        self.assertNotIn('Stale progress', path.read_text())
        self.assertEqual((self.root / 'Project.md').read_bytes(), original)
        self.assertEqual(len(self.acks), 3)

    def test_dry_run_writes_nothing(self):
        self.run_bridge(True)
        self.assertFalse((self.root / 'Agent Context').exists())
        self.assertFalse(self.acks)

    def test_refuses_human_file(self):
        path = self.root / self.item['file_path']
        path.parent.mkdir()
        path.write_text('# Human note\nDo not replace.')
        self.run_bridge()
        self.assertEqual(path.read_text(), '# Human note\nDo not replace.')
        self.assertFalse(self.acks)

    def test_preserves_manual_edits_to_managed_notes(self):
        self.run_bridge()
        path = self.root / self.item['file_path']
        path.write_text(path.read_text() + '\nHuman addition: keep this.\n')
        edited = path.read_bytes()
        self.item.update(revision=2, content='Replacement')
        self.run_bridge()
        self.assertEqual(path.read_bytes(), edited)
        self.assertEqual(len(self.acks), 1)

    def test_traversal_and_symlink_are_rejected(self):
        for path in ['../escape.md', 'Agent Context/../../escape.md', '/tmp/escape.md', 'Agent Context/..\\escape.md']:
            self.item['file_path'] = path
            self.run_bridge()
        self.assertFalse(self.acks)
        self.item['file_path'] = 'Agent Context/Task.md'
        with tempfile.TemporaryDirectory() as other:
            (self.root / 'Agent Context').symlink_to(other, target_is_directory=True)
            self.run_bridge()
            self.assertFalse(list(Path(other).iterdir()))
            self.assertFalse(self.acks)

if __name__ == '__main__':
    unittest.main()
