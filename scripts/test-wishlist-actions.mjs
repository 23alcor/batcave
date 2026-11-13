import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf("    if (a === 'wish-finish')"), app.indexOf("    if (a === 'wish-edit')"));
function setup(next, fail = false) {
  const buttons = [{ disabled: false }, { disabled: false }, { disabled: true }];
  const el = Object.assign(buttons[0], { dataset: { id: 'camera', status: next }, closest: () => ({}) });
  const calls = [], history = [];
  let renders = 0, focuses = 0;
  const context = {
    a: 'wish-finish', el, state: { wishItems: [{ id: 'camera', status: 'Searching' }] },
    $$: selector => selector === 'button' ? buttons : [],
    $: () => ({ focus() { focuses++; } }),
    api: async (path, options) => { calls.push({ path, ...options }); if (fail) throw new Error('Offline'); },
    remember: (...args) => history.push(args), render: async () => { renders++; },
  };
  return { buttons, calls, history, run: () => runInNewContext('(async () => {' + source + '})()', context),
    get renders() { return renders; }, get focuses() { return focuses; } };
}

for (const next of ['Bought', 'Gave up']) {
  test(`${next} shortcut saves status, refreshes filters, and supports undo/redo`, async () => {
    const s = setup(next); await s.run();
    assert.equal(s.calls[0].path, '/api/wishlist/camera');
    assert.equal(s.calls[0].method, 'PATCH'); assert.equal(s.calls[0].body.status, next);
    assert.equal(s.renders, 1); assert.equal(s.focuses, 1);
    await s.history[0][1](); assert.equal(s.calls[1].body.status, 'Searching');
    await s.history[0][2](); assert.equal(s.calls[2].body.status, next);
    assert.deepEqual(s.buttons.map(b => b.disabled), [false, false, true]);
  });
}
test('failed shortcuts restore buttons, preserve the card and do not record undo', async () => {
  const s = setup('Bought', true);
  await assert.rejects(s.run(), /Offline/);
  assert.deepEqual(s.buttons.map(b => b.disabled), [false, false, true]);
  assert.equal(s.renders, 0); assert.equal(s.history.length, 0);
});
