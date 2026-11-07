import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/worker.js';
import { chat } from '../src/chat.js';

function database() {
  const sql = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  }
  const prepare = (query, params = []) => {
    const ordered = [];
    const statement = () => sql.prepare(query.replace(/\?(\d+)/g, (_, n) => { ordered.push(params[+n - 1]); return '?'; }));
    return {
      bind: (...args) => prepare(query, args),
      async first(col) { ordered.length = 0; const row = statement().get(...ordered); return col ? row?.[col] ?? null : row ?? null; },
      async all() { ordered.length = 0; return { results: statement().all(...ordered) }; },
      async run() { ordered.length = 0; return { meta: { changes: Number(statement().run(...ordered).changes) } }; },
    };
  };
  const batch = async (list) => { sql.exec('BEGIN'); try { for (const s of list) await s.run(); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } };
  return { sql, prepare, batch };
}

function setup(t) {
  const DB = database();
  t.after(() => DB.sql.close());
  const env = { DB, MCP_TOKEN: 'mcp-test-token', INGEST_TOKEN: 'ingest-test-token', OWNER_NAME: 'Alex', TIMEZONE: 'America/New_York' };
  const ctx = { waitUntil() {} };
  const send = (path, token, method, body) => worker.fetch(new Request('https://test.invalid' + path, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  let id = 0;
  const rpc = async (method, params, token = env.MCP_TOKEN) => (await send('/mcp', token, 'POST', { jsonrpc: '2.0', id: ++id, method, params })).json();
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { ...r.result, data: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) };
  };
  return { env, send, rpc, call };
}

const NOTES = [
  { path: 'About Me.md', title: 'About Me', body: '# About Me\nComputer engineering student. Likes short answers.' },
  { path: '01 Projects/Batcave/Batcave.md', title: 'Batcave', folder: '01 Projects/Batcave', tags: 'project', updated_at: '2026-11-06T10:00', body: 'Personal dashboard on Cloudflare Workers with D1.' },
  { path: '01 Projects/Batcave/Sessions/2026-11-06 Batcave - Eating Out tab.md', title: '2026-11-06 Batcave - Eating Out tab', updated_at: '2026-11-06T22:00',
    body: '---\nproject: "[[Batcave]]"\n---\n## Summary\nBuilt the Eating Out tab.\n\n## Next steps\n- [ ] Share lists\n' },
];

test('MCP: auth, handshake, tool list and vault tools', async (t) => {
  const { send, rpc, call } = setup(t);
  assert.equal((await send('/mcp', 'wrong', 'POST', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await send('/api/ingest/vault', 'mcp-test-token', 'PUT', { notes: [] })).status, 401, 'the MCP token is not an ingest token');

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await send('/mcp', 'mcp-test-token', 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  const names = (await rpc('tools/list')).result.tools.map((x) => x.name);
  for (const n of ['whoami', 'search_notes', 'read_note', 'recent_sessions', 'log_session', 'find_tasks', 'create_task']) assert.ok(names.includes(n), n);
  for (const n of ['delete_recipe', 'cancel_event', 'update_task']) assert.ok(!names.includes(n), `${n} must not be exposed`);
  assert.equal((await rpc('nope')).error.code, -32601);

  const put = await send('/api/ingest/vault', 'ingest-test-token', 'PUT', { notes: NOTES, keep: NOTES.map((n) => n.path) });
  assert.deepEqual(await put.json(), { ok: true, saved: 3, removed: 0 });
  assert.equal((await send('/api/ingest/vault', 'ingest-test-token', 'PUT', { notes: [{ path: '../x.md', body: '' }] })).status, 400);

  assert.match((await call('whoami')).data.about_me, /Computer engineering/);
  const hits = (await call('search_notes', { query: 'cloudflare "D1' })).data.results;
  assert.equal(hits[0].path, '01 Projects/Batcave/Batcave.md');
  assert.match((await call('read_note', { path: 'batcave' })).data.body, /dashboard/);
  const sessions = (await call('recent_sessions', { days: 90, project: 'Batcave' })).data.sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].summary, 'Built the Eating Out tab.');
  assert.match(sessions[0].next_steps, /Share lists/);
  const missing = await call('read_note', { path: 'Nope' });
  assert.equal(missing.isError, true);

  // A note deleted in the vault disappears from the mirror and from search.
  const again = await send('/api/ingest/vault', 'ingest-test-token', 'PUT', { notes: [], keep: [NOTES[0].path, NOTES[2].path] });
  assert.equal((await again.json()).removed, 1);
  assert.equal((await call('search_notes', { query: 'cloudflare' })).data.results.length, 0);
});

test('MCP: create_task and log_session write through the existing code', async (t) => {
  const { env, call } = setup(t);
  const task = await call('create_task', { title: 'Read chapter 4', project: 'Other', inbox: true });
  assert.equal(task.isError, undefined, task.data);
  assert.equal(await env.DB.prepare("SELECT kind FROM tasks WHERE title = 'Read chapter 4'").first('kind'), 'inbox');

  const logged = await call('log_session', { transcript: 'User and assistant reviewed backpropagation and the chain rule in detail.', kind: 'study', source: 'chatgpt' });
  assert.equal(logged.data.ok, true);
  assert.equal(await env.DB.prepare('SELECT source FROM transcripts WHERE id = ?1').bind(logged.data.id).first('source'), 'chatgpt');
});

test('Alfred reads the vault and remembers: the owner via the bridge queue, a friend in their own vault', async (t) => {
  const { env, send } = setup(t);
  await send('/api/ingest/vault', 'ingest-test-token', 'PUT', { notes: NOTES });
  const friendDB = database(); // a friend's own database: empty vault
  t.after(() => friendDB.sql.close());
  const lib = { localNow: () => ({ date: '2026-11-07', time: '12:00' }), addDays: (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10) };
  let script = [];
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body);
    const outputs = body.input.filter((x) => x.type === 'function_call_output');
    const next = script[outputs.length];
    if (next) return new Response(JSON.stringify({ output: [{ type: 'function_call', name: next[0], arguments: JSON.stringify(next[1]), call_id: String(outputs.length) }] }));
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: outputs.map((o) => o.output).join('\n') }] }] }));
  });
  const ask = async (db, uid, steps) => {
    script = steps;
    const res = await chat(new Request('https://test.invalid/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }),
      { ...env, DB: db, OPENAI_API_KEY: 'mock', UID: uid }, lib);
    return (await res.json()).reply;
  };

  // The owner: reads the mirrored vault; remembered facts wait for the bridge, which files them.
  assert.match(await ask(env.DB, 0, [['whoami', {}]]), /Computer engineering student/);
  assert.ok(seen[0].tools.some((x) => x.name === 'remember'));
  assert.match(seen[0].instructions, /save it with remember without asking/);
  await ask(env.DB, 0, [['remember', { fact: 'Has a saltwater reef tank' }], ['remember', { fact: 'has a saltwater reef tank' }]]);
  const queued = await (await send('/api/ingest/memories', 'ingest-test-token', 'GET')).json();
  assert.deepEqual(queued.memories.map((m) => [m.fact, m.note]), [['Has a saltwater reef tank', 'About Me']], 'saved once');
  assert.match(await ask(env.DB, 0, [['whoami', {}]]), /just_remembered.*reef tank/);
  const filed = await send('/api/ingest/memories/filed', 'ingest-test-token', 'POST', { ids: [queued.memories[0].id] });
  assert.equal((await filed.json()).remaining, 0);

  // A friend: their own vault, built as they talk, never the owner's notes.
  assert.match(await ask(friendDB, 1, [['whoami', {}]]), /No \\"About Me\\" note yet/);
  await ask(friendDB, 1, [['remember', { fact: 'Studies nursing at Hunter College' }], ['remember', { fact: 'Sister is named Maya', note: 'People' }]]);
  assert.match(await ask(friendDB, 1, [['whoami', {}]]), /Studies nursing at Hunter College/);
  assert.match(await ask(friendDB, 1, [['search_notes', { query: 'maya' }]]), /People\.md/);
  assert.doesNotMatch(await ask(friendDB, 1, [['search_notes', { query: 'cloudflare' }]]), /Batcave/);
  assert.match(await ask(friendDB, 1, [['forget', { text: 'nursing' }]]), /Forgot: Studies nursing/);
  assert.doesNotMatch(await ask(friendDB, 1, [['whoami', {}]]), /nursing/);

  // The preview never gets vault or memory tools.
  await ask(env.DB, 'demo', []);
  assert.ok(!seen.at(-1).tools.some((x) => ['whoami', 'remember'].includes(x.name)));
});

test('related_notes follows links both ways, including concepts without a note', async (t) => {
  const { send, call } = setup(t);
  const notes = [
    { path: 'Courses/EECE 448.md', title: 'EECE 448', updated_at: '2026-11-01T10:00', body: 'Uses [[Backpropagation]] and [[CUDA|GPUs]].\n![[Lectures.base#By course]]\nSee [[Research]].' },
    { path: 'Research.md', title: 'Research', updated_at: '2026-11-02T10:00', body: '# Research\nGPU work, see [[CUDA]].' },
    { path: 'S/2026-11-05 EECE 448 - Backprop review.md', title: '2026-11-05 EECE 448 - Backprop review', updated_at: '2026-11-05T10:00', body: '---\nproject: "[[Courses/EECE 448]]"\n---\nReviewed [[Backpropagation#Chain rule]].' },
    { path: 'Other.md', title: 'Other', body: 'Mentions EECE 448 without a link, and [[EECE 4480]].' },
  ];
  await send('/api/ingest/vault', 'ingest-test-token', 'PUT', { notes });
  const r = (await call('related_notes', { note: 'EECE 448' })).data;
  assert.deepEqual(r.links_to.map((x) => x.path), ['Research.md']);
  assert.deepEqual(r.mentions_without_note.sort(), ['Backpropagation', 'CUDA'], 'aliases resolve; .base embeds are skipped');
  assert.deepEqual(r.linked_from.map((x) => x.title), ['2026-11-05 EECE 448 - Backprop review'], 'path-style link counts; plain text and [[EECE 4480]] do not');
  assert.match(r.linked_from[0].context, /project:/);
  const concept = (await call('related_notes', { note: 'backpropagation' })).data;
  assert.equal(concept.note.has_own_note, false);
  assert.deepEqual(concept.linked_from.map((x) => x.path).sort(), ['Courses/EECE 448.md', 'S/2026-11-05 EECE 448 - Backprop review.md']);
});
