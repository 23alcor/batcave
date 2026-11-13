import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf("document.addEventListener('paste',"), app.indexOf('const WISH_STATUSES'));
const image = { type: 'image/png', size: 100, name: 'Clipboard.png' };
function setup({ kept = [], queued = [], urls = '', shrink = async () => 'data:image/png;base64,aGVsbG8=' } = {}) {
  let listener;
  const calls = [], added = [], save = { disabled: false }, status = { hidden: true, textContent: '' };
  const form = { dataset: {}, fields: { keep_image: kept, uploads: queued }, nodes: {
    'button[type="submit"]': save, '[data-wish-paste-status]': status,
    '[data-wish-pasted]': { insertAdjacentHTML(position, html) { assert.equal(position, 'beforeend'); added.push(html); } },
  } };
  const area = { value: urls, closest: () => form };
  const context = {
    document: { addEventListener(type, handler) { assert.equal(type, 'paste'); listener = handler; } },
    $: (selector, target) => target.nodes[selector], esc: String,
    FormData: class { constructor(target) { this.target = target; } getAll(name) { return this.target.fields[name] || []; } },
    shrinkImage: async (file, budget) => { calls.push({ file, budget }); return shrink(file, budget); },
  };
  runInNewContext(source, context);
  const paste = files => {
    const event = { target: { closest: () => area }, clipboardData: { files }, prevented: false, preventDefault() { this.prevented = true; } };
    return { event, done: listener(event) };
  };
  return { paste, calls, added, save, status, area, form };
}

test('pasted images reuse compression, reserve space for selected files, and join the existing keep-image fields', async () => {
  const kept = ['data:image/png;base64,c2F2ZWQ='];
  const s = setup({ kept, queued: [image], urls: ' https://example.com/a.png\n' });
  const { event, done } = s.paste([image, image]); await done;
  assert.equal(event.prevented, true); assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0].budget, (650000 - kept.join('').length) / 3);
  assert.equal((s.added[0].match(/name="keep_image"/g) || []).length, 2);
  assert.match(s.added[0], /checked/); assert.match(s.status.textContent, /Pasted 2 images/);
  assert.equal(s.area.value, 'https://example.com/a.png');
  assert.equal(s.save.disabled, false); assert.equal(s.form.dataset.wishPasting, undefined);
});

test('ordinary URL or text pasting stays native and does not create image uploads', async () => {
  const s = setup({ urls: 'https://example.com/existing.png' });
  const { event, done } = s.paste([]); await done;
  assert.equal(event.prevented, false); assert.equal(s.calls.length, 0);
  assert.equal(s.area.value, 'https://example.com/existing.png'); assert.equal(s.status.hidden, true);
});

test('image limits and decoding failures leave the form usable without partially adding images', async () => {
  for (const options of [{ kept: Array(6).fill('saved') }, { kept: ['x'.repeat(649000)] }, { shrink: async () => { throw new Error('Could not open clipboard image'); } }]) {
    const s = setup(options); await s.paste([image]).done;
    assert.equal(s.added.length, 0); assert.equal(s.save.disabled, false);
    assert.equal(s.form.dataset.wishPasting, undefined); assert.ok(s.status.textContent);
  }
});

test('overlapping pastes cannot race the image budget or re-enable saving prematurely', async () => {
  let finish;
  const s = setup({ shrink: () => new Promise(resolve => { finish = resolve; }) });
  const first = s.paste([image]); assert.equal(s.save.disabled, true); assert.equal(s.form.dataset.wishPasting, '1');
  const second = s.paste([image]); await second.done;
  assert.equal(s.calls.length, 1); assert.equal(s.save.disabled, true);
  finish('data:image/png;base64,aGVsbG8='); await first.done;
  assert.equal(s.added.length, 1); assert.equal(s.save.disabled, false);
});
