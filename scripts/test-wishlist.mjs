import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { wishlist, wishlistDB } from '../src/wishlist.js';
import worker from '../src/worker.js';

function database(files) {
  const sql = new DatabaseSync(':memory:');
  for (const file of files) sql.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  const prepare = (query, params = []) => {
    const ordered = /\?\d+/.test(query) ? [] : [...params];
    const statement = () => sql.prepare(query.replace(/\?(\d+)/g, (_, n) => { ordered.push(params[+n - 1]); return '?'; }));
    return ({
    bind(...args) { return prepare(query, args); },
    async first(column) { const row = statement().get(...ordered); return column ? row?.[column] ?? null : row ?? null; },
    async all() { return { results: statement().all(...ordered) }; },
    async run() { return { meta: { changes: Number(statement().run(...ordered).changes) } }; },
  }); };
  const batch = async statements => {
    sql.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  };
  return { sql, prepare, batch };
}
function setup(t) {
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort();
  const main = database(files), friend = database(files.filter(f => /^(0001|0003|0004|0005|0006|0007|0009|0012)_/.test(f)));
  t.after(() => { main.sql.close(); friend.sql.close(); });
  main.sql.exec("INSERT INTO users (id, name, email, password_hash) VALUES (1, 'Alex', 'alex@example.com', 'test'), (2, 'Sam', 'sam@example.com', 'test')");
  const USERDB = { idFromName: id => id, get(id) {
    assert.equal(id, 'user:1');
    return { async query(statements) { return Promise.all(statements.map(({ sql, params }) => /^(INSERT|UPDATE|DELETE)/i.test(sql) ? friend.prepare(sql).bind(...params).run() : friend.prepare(sql).bind(...params).all())); } };
  } };
  const env = uid => ({ UID: uid, DB: uid === 1 ? friend : main, ...(uid ? { D1: main } : {}), USERDB, OWNER_NAME: 'Robin' });
  const call = async (uid, path = '', method = 'GET', data) => {
    const req = new Request('https://test.invalid/api/wishlist' + path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return wishlist(req, env(uid), '/api/wishlist' + path, method, '2026-11-06');
  };
  return { main, friend, call, env };
}

test('wishlist uploads and multiple links persist, editing preserves status fields, and legacy links survive', async t => {
  const { main, call } = setup(t);
  const image = 'data:image/png;base64,aGVsbG8=';
  const created = await call(0, '', 'POST', { name: 'Camera', price: '0', links: ['https://example.com/camera', 'https://example.org/review'], images: [image, 'https://example.com/photo.jpg'] });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  let item = (await (await call(0)).json()).items[0];
  assert.equal(item.price, 0); assert.equal(item.images[0], image); assert.equal(item.links.length, 2);
  assert.equal((await call(0, '/' + id, 'PATCH', { status: 'Bought' })).status, 200);
  assert.equal((await call(0, '/' + id, 'PATCH', { links: [], images: [] })).status, 200);
  item = (await (await call(0)).json()).items[0];
  assert.equal(item.status, 'Bought'); assert.equal(item.acquired_on, '2026-11-06'); assert.deepEqual(item.images, []); assert.deepEqual(item.links, []);
  main.sql.exec("INSERT INTO wishlist (id, name, link) VALUES ('old', 'Old item', 'https://example.com/old')");
  assert.deepEqual((await (await call(0)).json()).items.find(i => i.id === 'old').links, ['https://example.com/old']);
});

test('wishlist rejects unsafe media, invalid fields and oversized uploads without writing', async t => {
  const { call } = setup(t);
  for (const fields of [
    { links: ['javascript:alert(1)'] }, { links: ['https://user:password@example.com'] }, { links: Array(11).fill('https://example.com') },
    { images: ['data:image/svg+xml;base64,PHN2Zz4='] }, { images: ['data:image/png;base64,' + 'a'.repeat(700000)] },
    { images: Array(7).fill('https://example.com/image.jpg') }, { images: ['file:///secret'] }, { price: -1 }, { price: {} }, { status: 'invalid' }, { name: 123 },
  ]) assert.equal((await call(0, '', 'POST', { name: 'Invalid', ...fields })).status, 400, JSON.stringify(fields).slice(0, 100));
  assert.deepEqual((await (await call(0)).json()).items, []);
  assert.equal((await call(0, '/missing', 'PATCH', { status: 'Bought' })).status, 404);
  assert.equal((await worker.fetch(new Request('https://test.invalid/api/wishlist'), {})).status, 401);
});

test('sharing supports owner id zero, one-time codes, scoped edits, private restoration and host revocation', async t => {
  const { call, main } = setup(t);
  const ownerItem = await (await call(0, '', 'POST', { name: 'Shared camera' })).json();
  const personal = await (await call(1, '', 'POST', { name: 'Private bike' })).json();
  const { code } = await (await call(0, '/share', 'POST')).json();
  assert.equal((await call(1, '/join', 'POST', { code: code.toLowerCase() })).status, 200);
  assert.equal((await call(2, '/join', 'POST', { code })).status, 404);
  const shared = await (await call(1)).json();
  assert.deepEqual(shared.members, ['Robin']); assert.equal(shared.own, false);
  assert.equal(shared.items[0].id, ownerItem.id);
  assert.equal((await call(1, '/' + personal.id, 'PATCH', { name: 'Not accessible' })).status, 404);
  assert.equal((await call(1, '/' + ownerItem.id, 'PATCH', { name: 'Edited together' })).status, 200);
  assert.equal(main.sql.prepare('SELECT name FROM wishlist WHERE id = ?').get(ownerItem.id).name, 'Edited together');
  assert.deepEqual((await (await call(0)).json()).members, ['Alex']);
  await call(1, '/leave', 'POST');
  assert.equal((await (await call(1)).json()).items[0].name, 'Private bike');
  const invite = await (await call(0, '/share', 'POST')).json();
  await call(1, '/join', 'POST', invite);
  const stale = await (await call(1, '/share', 'POST', {})).json();
  await call(0, '/leave', 'POST', {});
  assert.equal((await (await call(1)).json()).items[0].name, 'Private bike');
  assert.equal((await call(2, '/join', 'POST', stale)).status, 404);
});

test('a friend can host a wishlist without exposing their other tables; joining a different list requires leaving', async t => {
  const { call, env, main, friend } = setup(t);
  await call(1, '', 'POST', { name: 'Friend camera' });
  const invite = await (await call(1, '/share', 'POST', {})).json();
  assert.equal((await call(0, '/join', 'POST', invite)).status, 200);
  assert.equal((await (await call(0)).json()).items[0].name, 'Friend camera');
  const sharedDB = await wishlistDB(env(0));
  assert.equal((await sharedDB.prepare('SELECT COUNT(*) AS n FROM wishlist').first('n')), 1);
  assert.equal(main.sql.prepare('SELECT COUNT(*) AS n FROM wishlist').get().n, 0);
  const another = await (await call(2, '/share', 'POST', {})).json();
  assert.equal((await call(0, '/join', 'POST', another)).status, 400);
  assert.equal((await call(1, '/join', 'POST', another)).status, 400);
  await call(0, '/leave', 'POST', {});
  assert.deepEqual((await (await call(0)).json()).items, []);
  assert.equal(friend.sql.prepare('SELECT COUNT(*) AS n FROM wishlist').get().n, 1);
});
