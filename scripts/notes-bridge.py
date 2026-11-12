"""Create queued Obsidian notes; run alongside the existing vault mirror bridge."""
import argparse
import importlib.util
import json
import os
import re
import sys
import uuid
from pathlib import Path

sys.dont_write_bytecode = True


def save_note(vault, item):
    title, folder, content = item['title'], item['folder'], item['content']
    ident = str(uuid.UUID(item['id']))
    if ident != item['id'] or not isinstance(content, str) or not content.strip() or len(content) > 20000 or '\0' in content:
        raise ValueError('Invalid note request')
    if not title or len(title) > 120 or re.search(r'[\x00-\x1f\x7f\\/:#^|\[\]?*"<>]', title) or title.endswith(('.', ' ')) or title.lower().endswith('.md'):
        raise ValueError('Invalid title')
    parts = folder.split('/')
    if parts[0] not in ['00 Home', '10 Learning and Teaching', '20 Work and Career', '30 Project and Hobby', '40 Content and Creativity', '80 Knowledge Library']:
        raise ValueError('Folder is not a regular note folder')
    for part in parts:
        if not part or part.startswith('.') or part.endswith(('.', ' ')) or re.search(r'[\x00-\x1f\x7f\\:#^|\[\]?*"<>]', part) or part.lower() in ['templates','attachments','agent context','daily notes','sessions','transcripts','memory']:
            raise ValueError('Protected or unsafe folder')
    if item['path'] != folder + '/' + title + '.md':
        raise ValueError('Path does not match title and folder')
    text = '\n'.join(['---', 'type: note', 'created_by: batcave', 'batcave_note_id: ' + ident,
                      'created: ' + json.dumps(item['created_at']), '---', '# ' + title, '', content, '']).encode()
    fd = os.open(vault, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        name = title + '.md'
        temp = '.' + ident + '.tmp-' + uuid.uuid4().hex
        try:
            out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            with os.fdopen(out, 'wb') as stream:
                stream.write(text)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                os.fsync(fd)
            except FileExistsError:
                old = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(old, 'rb') as stream:
                    import stat
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or stream.read(len(text)+1) != text:
                        raise ValueError('Existing note differs; preserved without changes')
        finally:
            os.unlink(temp, dir_fd=fd)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vault', default=str(Path.home() / 'Documents/Bat Vault'))
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('bridge', Path(args.vault) / '.tools/batcave-bridge.py')
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    cfg = bridge.load_config()
    for item in bridge.call(cfg, 'GET', '/api/ingest/notes')['notes']:
        try:
            save_note(args.vault, item)
        except (ValueError, KeyError, TypeError) as error:
            bridge.call(cfg, 'POST', '/api/ingest/notes/filed', {'id':item['id'], 'status':'error', 'error':str(error)})
            continue
        except OSError as error:
            print('Note remains queued:', item['id'], type(error).__name__)
            continue
        bridge.call(cfg, 'POST', '/api/ingest/notes/filed', {'id':item['id'], 'status':'saved'})
        print('Saved:', item['path'])


if __name__ == '__main__':
    main()
