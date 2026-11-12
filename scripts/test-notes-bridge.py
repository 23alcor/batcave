import importlib.util
import tempfile
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('notes', Path(__file__).with_name('notes-bridge.py'))
notes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notes)

class Notes(unittest.TestCase):
    def test_create_retry_conflict_and_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'30 Project and Hobby').mkdir()
            item = dict(id='12345678-1234-1234-1234-123456789abc', title='Test', folder='30 Project and Hobby', content='Keep this', path='30 Project and Hobby/Test.md', created_at='2026-11-10T12:00:00Z')
            notes.save_note(root,item)
            path=root/item['path']; original=path.read_bytes()
            notes.save_note(root,item)
            self.assertEqual(path.read_bytes(),original)
            path.write_text('Human edit')
            with self.assertRaises(ValueError): notes.save_note(root,item)
            self.assertEqual(path.read_text(),'Human edit')
            for folder in ['../outside','30 Project and Hobby/../outside','30 Project and Hobby/.secret','30 Project and Hobby/Sessions']:
                with self.assertRaises(ValueError): notes.save_note(root,{**item,'folder':folder,'path':folder+'/Test.md'})
            with tempfile.TemporaryDirectory() as outside:
                (root/'30 Project and Hobby'/'Link').symlink_to(outside)
                with self.assertRaises(OSError): notes.save_note(root,{**item,'folder':'30 Project and Hobby/Link','path':'30 Project and Hobby/Link/Test.md'})
                self.assertEqual(list(Path(outside).iterdir()),[])

if __name__ == '__main__': unittest.main()
