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

test('Alfred reads the vault for the owner only', async (t) => {
  const { env, send } = setup(t);
  await send('/api/ingest/vault', 'ingest-test-token', 'PUT', { notes: NOTES });
  const lib = { localNow: () => ({ date: '2026-11-07', time: '12:00' }), addDays: (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10) };
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body);
    const outputs = body.input.filter((x) => x.type === 'function_call_output');
    if (!outputs.length && body.tools.some((x) => x.name === 'whoami')) {
      return new Response(JSON.stringify({ output: [{ type: 'function_call', name: 'whoami', arguments: '{}', call_id: '1' }] }));
    }
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: outputs.length ? JSON.parse(outputs[0].output).about_me : 'no vault' }] }] }));
  });
  const ask = async (uid) => (await (await chat(new Request('https://test.invalid/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Who am I?' }] }) }),
    { ...env, OPENAI_API_KEY: 'mock', UID: uid }, lib)).json()).reply;
  assert.match(await ask(0), /Computer engineering student/);
  assert.match(seen[0].instructions, /Their notes vault/);
  assert.equal(await ask(1), 'no vault', 'a friend never gets the owner\'s vault tools');
  assert.doesNotMatch(seen.at(-1).instructions, /Their notes vault/);
});
