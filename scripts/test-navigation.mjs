import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageRenderer } from '../public/navigation.js';

function setup({ native = true, reduced = false, update = async () => {} } = {}) {
  const calls = [], attributes = new Map();
  const win = { location: { hash: '#/spending' }, matchMedia: () => ({ matches: reduced }) };
  const doc = { defaultView: win };
  if (native) doc.startViewTransition = fn => {
    calls.push('transition'); const done = Promise.resolve().then(fn);
    return { ready: done, finished: done, updateCallbackDone: done };
  };
  const view = { ownerDocument: doc, setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k), animate: () => calls.push('fallback'), getAnimations: () => [] };
  const render = createPageRenderer(async () => { calls.push(win.location.hash); assert.equal(attributes.get('aria-busy'), 'true'); await update(); }, view);
  return { render, win, calls, attributes };
}

test('app and budget routes transition, while first load and same-page refreshes stay still', async () => {
  const { render, win, calls, attributes } = setup();
  await render(); await render();
  win.location.hash = '#/spending/subscriptions'; await render();
  win.location.hash = '#/inbox'; await render();
  assert.equal(calls.filter(c => c === 'transition').length, 2);
  assert.equal(attributes.has('aria-busy'), false);
});

test('reduced motion skips animation and unsupported browsers use an entrance fade', async () => {
  for (const reduced of [false, true]) {
    const { render, win, calls } = setup({ native: false, reduced });
    await render(); win.location.hash = '#/spending/transactions'; await render();
    assert.equal(calls.includes('fallback'), !reduced);
  }
  const { render, win, calls } = setup({ reduced: true });
  await render(); win.location.hash = '#/inbox'; await render(); assert.equal(calls.includes('transition'), false);
});

test('rapid navigation coalesces pending routes and waits for an active render', async () => {
  let finish, first = true;
  const { render, win, calls } = setup({ update: () => { if (first) { first = false; return new Promise(resolve => { finish = resolve; }); } } });
  const active = render(); await Promise.resolve();
  win.location.hash = '#/spending/transactions'; const intermediate = render();
  win.location.hash = '#/spending/subscriptions'; const latest = render();
  finish(); await Promise.all([active, intermediate, latest]);
  assert.deepEqual(calls.filter(c => c.startsWith('#')), ['#/spending', '#/spending/subscriptions']);
});

test('failed renders release the busy state and do not break later navigation', async () => {
  let fail = false;
  const { render, win, attributes } = setup({ update: () => { if (fail) throw new Error('Unavailable'); } });
  await render(); fail = true; win.location.hash = '#/inbox';
  await assert.rejects(render(), /Unavailable/); assert.equal(attributes.has('aria-busy'), false);
  fail = false; win.location.hash = '#/spending'; await render(); assert.equal(attributes.has('aria-busy'), false);
});
