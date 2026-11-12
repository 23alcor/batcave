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

test('Agent contexts isolate concurrent tasks, reject stale saves, and confirm bridge filing', async (t) => {
  const { env, send, call } = setup(t);
  await send('/api/ingest/vault', env.INGEST_TOKEN, 'PUT', { notes: [
    { path: 'Projects/Graph/Graph.md', title: 'Graph', body: '---\ntype: project\n---\n# Graph\nHuman-authored project description.' },
    { path: 'Projects/Graph/Design.md', title: 'Design', body: '# Design\n## Decisions\nUse bookmarks.\n## Next\nBuild graph.' },
  ] });
  const a = (await call('resume_task', { project: 'Graph', task: 'Retrieval', agent: 'Claude' })).data;
  const b = (await call('resume_task', { project: 'Graph', task: 'Interface', agent: 'Codex' })).data;
  assert.notEqual(a.session_id, b.session_id);
  assert.equal(a.revision, 0);
  const save = { project: 'Graph', task: 'Retrieval', entry_note: 'Design', content: 'SECRET_CONTENT_IN_HANDOFF only, not telemetry.', next_action: 'Implement section reads', expected_revision: 0, session_id: a.session_id };
  const first = (await call('save_handoff', save)).data;
  assert.equal(first.status, 'queued');
  assert.equal(first.revision, 1);
  assert.match(first.path, /^Projects\/Graph\/Agent Context\//);
  const stale = await call('save_handoff', { ...save, content: 'Overwrite' });
  assert.equal(stale.isError, true);
  assert.match(stale.data, /Revision conflict/);
  const second = (await call('save_handoff', { ...save, content: 'Merged progress', expected_revision: 1 })).data;
  assert.equal(second.revision, 2);
  assert.equal(second.path, first.path);
  const other = (await call('save_handoff', { ...save, task: 'Interface', content: 'Interface progress', session_id: b.session_id })).data;
  assert.notEqual(other.path, first.path);
  const unchanged = (await call('resume_task', { project: 'Graph', task: 'Retrieval', since_revision: 2, session_id: a.session_id })).data;
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.handoff, undefined);
  const resumed = (await call('resume_project', { project: 'Graph', agent: 'Reviewer' })).data;
  assert.equal(resumed.tasks.length, 2);
  assert.equal(resumed.brief, null);
  const brief = (await call('save_project_brief', { project: 'Graph', entry_note: 'Design', content: 'A graph for agent activity', expected_revision: 0, session_id: resumed.session_id })).data;
  assert.equal(brief.revision, 1);
  assert.equal((await call('save_handoff', { ...save, content: 'x'.repeat(3001), expected_revision: 2 })).isError, true);
  assert.equal((await call('resume_task', { project: 'Graph', task: 'Retrieval', session_id: 'unknown' })).isError, true);
  const queue = await (await send('/api/ingest/contexts', env.INGEST_TOKEN, 'GET')).json();
  assert.equal(queue.contexts.length, 3);
  assert.equal((await send('/api/ingest/contexts', env.MCP_TOKEN, 'GET')).status, 401);
  assert.equal((await send('/api/agent-graph', env.INGEST_TOKEN, 'GET')).status, 401);
  const before = await (await send('/api/agent-graph', env.MCP_TOKEN, 'GET')).json();
  assert.ok(before.events.some((e) => e.action === 'save_requested' && e.session_id === a.session_id));
  assert.ok(!JSON.stringify(before).includes('SECRET_CONTENT_IN_HANDOFF'));
  assert.ok(!before.events.some((e) => e.action === 'file_saved'));
  assert.equal((await send('/api/ingest/contexts/filed', env.INGEST_TOKEN, 'POST', { id: first.context_id, revision: 999 })).status, 409);
  await send('/api/ingest/contexts/filed', env.INGEST_TOKEN, 'POST', { id: first.context_id, revision: 1 });
  let queued = (await (await send('/api/ingest/contexts', env.INGEST_TOKEN, 'GET')).json()).contexts;
  assert.ok(queued.some((c) => c.id === first.context_id), 'acknowledging revision 1 must not clear pending revision 2');
  await send('/api/ingest/contexts/filed', env.INGEST_TOKEN, 'POST', { id: first.context_id, revision: 2 });
  await send('/api/ingest/contexts/filed', env.INGEST_TOKEN, 'POST', { id: first.context_id, revision: 2 });
  const after = await (await send('/api/agent-graph', env.MCP_TOKEN, 'GET')).json();
  assert.equal(after.events.filter((e) => e.action === 'file_saved' && e.ref === first.context_id + ':2').length, 1);
  assert.equal(after.contexts.find((c) => c.id === first.context_id).filed_revision, 2);
  assert.match((await call('read_note', { path: 'Graph' })).data.body, /Human-authored/);
});

test('Bounded note reads preserve complete JSON, literal headings and continuation offsets', async (t) => {
  const { send, call, env } = setup(t);
  const content = '# Long note\n## A.*\n' + 'actual content '.repeat(1400) + '\n```md\n## Inside code\n```\n### Nested\nKeep this.\n## Other\nDo not include.';
  await send('/api/ingest/vault', env.INGEST_TOKEN, 'PUT', { notes: [{ path: 'Long.md', title: 'Long', body: content }] });
  const first = (await call('read_note', { path: 'Long', section: 'A.*', max_chars: 200 })).data;
  assert.equal(first.body.length, 200);
  assert.equal(first.truncated, true);
  assert.equal(first.next_offset, 200);
  const second = (await call('read_note', { path: 'Long', section: 'A.*', offset: first.next_offset, max_chars: 12000 })).data;
  assert.equal(second.body, content.slice(content.indexOf('## A.*') + 200, content.indexOf('## A.*') + 12200));
  const tail = (await call('read_note', { path: 'Long', section: 'A.*', offset: second.next_offset, max_chars: 12000 })).data;
  assert.match(tail.body, /Inside code/);
  assert.match(tail.body, /Keep this/);
  assert.doesNotMatch(tail.body, /Do not include/);
  assert.equal(tail.next_offset, null);
  for (const args of [{ offset: -1 }, { max_chars: 90000 }, { section: 'A' }]) assert.equal((await call('read_note', { path: 'Long', ...args })).isError, true);
});

test('Activity has exact inserted ids and initialization identity; unauthenticated sockets receive no data', async (t) => {
  const { AgentGraphHub, recordActivity } = await import('../src/agent-graph.js');
  const { env, send } = setup(t);
  const initialized = await send('/mcp', env.MCP_TOKEN, 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Test client' } } });
  const session = initialized.headers.get('Mcp-Session-Id');
  assert.ok(session);
  const ids = await Promise.all([recordActivity(env, session, 'read_note', ['A.md']), recordActivity(env, session, 'read_note', ['B.md'])]);
  assert.notEqual(ids[0], ids[1]);
  const makeSocket = () => ({ state: { authenticated: false, deadline: Date.now() + 10000 }, sent: [], closed: [], deserializeAttachment() { return this.state; }, serializeAttachment(s) { this.state=s; }, send(s) { this.sent.push(JSON.parse(s)); }, close(...a) { this.closed.push(a); } });
  const bad = makeSocket(), good = makeSocket(), waiting = makeSocket();
  const hub = new AgentGraphHub({ getWebSockets: () => [bad, good, waiting] }, env);
  await hub.webSocketMessage(bad, JSON.stringify({ type: 'authenticate', token: 'wrong' }));
  assert.equal(bad.closed[0][0], 1008);
  await hub.webSocketMessage(good, JSON.stringify({ type: 'authenticate', token: env.MCP_TOKEN }));
  assert.equal(good.sent[0].type, 'connected');
  await hub.publish({ action: 'read_note', paths: ['A.md'] });
  assert.equal(good.sent[1].type, 'activity');
  assert.equal(waiting.sent.length, 0);
  assert.equal(bad.sent.length, 0);
  const oldKey = env.MCP_TOKEN; env.MCP_TOKEN = 'rotated-test-key';
  await hub.publish({ action: 'read_note', paths: ['B.md'] });
  assert.equal(good.closed[0][0], 1008);
  assert.equal(good.sent.length, 2, 'rotated keys stop receiving activity');
  env.MCP_TOKEN = oldKey;
  const oversize = makeSocket();
  await hub.webSocketMessage(oversize, 'x'.repeat(4097));
  assert.equal(oversize.closed[0][0], 1008);
});


test('One connector keeps task identities separate, section bookmarks resume correctly, and friends cannot write contexts', async (t) => {
  const { contextTools } = await import('../src/agent-graph.js');
  const { env, send, call } = setup(t);
  await send('/api/ingest/vault', env.INGEST_TOKEN, 'PUT', { notes: [{ path: 'Projects/P/P.md', title: 'P', body: '---\ntype: project\n---\n# P\n## Decisions\nKeep separate tasks.' }] });
  const initialized = await send('/mcp', env.MCP_TOKEN, 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Shared connector' } } });
  const base = initialized.headers.get('Mcp-Session-Id');
  const a = (await call('resume_task', { project: 'P', task: 'A', session_id: base })).data;
  const b = (await call('resume_task', { project: 'P', task: 'B', session_id: base })).data;
  assert.notEqual(a.session_id, b.session_id);
  assert.equal((await env.DB.prepare('SELECT task FROM agent_sessions WHERE id=?1').bind(a.session_id).first()).task, 'A');
  const saved = (await call('save_handoff', { project: 'P', task: 'A', entry_note: 'P#Decisions', content: 'Keep tasks separate', next_action: 'Continue A', expected_revision: 0, session_id: a.session_id })).data;
  assert.equal(saved.revision, 1);
  const resumed = (await call('resume_task', { project: 'P', task: 'A' })).data;
  assert.equal(resumed.handoff.entry_note, 'Projects/P/P.md#Decisions');
  assert.match((await call('read_note', { path: resumed.handoff.entry_note })).data.body, /Keep separate tasks/);
  await call('save_handoff', { project: 'P', task: 'A', entry_note: 'P#Decisions', content: 'New agent continued A', next_action: 'Continue', expected_revision: 1, session_id: resumed.session_id });
  await send('/api/ingest/contexts/filed', env.INGEST_TOKEN, 'POST', { id: saved.context_id, revision: 1 });
  const filed = await env.DB.prepare("SELECT session_id FROM agent_events WHERE action='file_saved' AND ref=?1").bind(saved.context_id + ':1').first();
  assert.equal(filed.session_id, a.session_id, 'a delayed acknowledgement belongs to the agent that saved that revision');
  assert.equal((await call('save_handoff', { project: 'P', task: 'A', entry_note: 'P', content: 'Wrong identity', next_action: 'No', expected_revision: 1, session_id: b.session_id })).isError, true);
  await assert.rejects(contextTools({ ...env, UID: 1 }).resume_project({ project: 'P' }), /only to the owner/);
});

test('new Obsidian notes are owner-only, idempotent, and saved only after bridge acknowledgement', async t => {
  const {env, call, send} = setup(t);
  await send('/api/ingest/vault', env.INGEST_TOKEN, 'PUT', {notes:[{path:'30 Project and Hobby/Project.md',folder:'30 Project and Hobby',title:'Project',body:'# Project'}]});
  const args={title:'New idea',folder:'30 Project and Hobby',content:'A useful [[Project]] idea.'};
  const created=(await call('create_note',args)).data;
  assert.equal(created.status,'queued'); assert.equal(created.saved,false);
  assert.equal((await call('create_note',args)).data.id,created.id);
  assert.equal((await call('create_note',{...args,content:'Different'})).isError,true);
  assert.equal((await call('create_note',{...args,title:'Project'})).isError,true);
  assert.equal((await call('create_note',{...args,folder:'../escape'})).isError,true);
  assert.equal((await send('/api/ingest/notes','wrong','GET')).status,401);
  assert.equal((await (await send('/api/ingest/notes',env.INGEST_TOKEN,'GET')).json()).notes.length,1);
  assert.equal((await call('note_status',{request_id:created.id})).data.saved,false);
  await send('/api/ingest/notes/filed',env.INGEST_TOKEN,'POST',{id:created.id,status:'saved'});
  assert.equal((await call('note_status',{request_id:created.id})).data.saved,true);
  assert.equal((await send('/api/ingest/notes/filed',env.INGEST_TOKEN,'POST',{id:created.id,status:'error',error:'late'})).status,409);
  const {noteTools}=await import('../src/note-requests.js');
  await assert.rejects(noteTools({...env,UID:1}).create_note(args),/only to the owner/);
});


test('MCP budget tools accept session metadata but only prepare proposals and expose no approval tool', async t => {
  const { call, rpc, env } = setup(t);
  const initialized = await rpc('initialize', { clientInfo: { name: 'Budget test' }, protocolVersion: '2025-06-18' });
  assert.ok(initialized.result);
  const session_id = env.DB.sql.prepare('SELECT id FROM agent_sessions ORDER BY rowid DESC LIMIT 1').get().id;
  const listing = await rpc('tools/list');
  assert.ok(listing.result.tools.some(t => t.name === 'get_budget'));
  assert.ok(!listing.result.tools.some(t => /approve.*budget|delete.*budget/.test(t.name)));
  const result = await call('propose_budget_change', { session_id, resource: 'category', action: 'create', fields: { name: 'Books' }, reason: 'Requested category' });
  assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.data.status, 'pending');
  assert.equal(env.DB.sql.prepare("SELECT count(*) n FROM budget_records WHERE kind='category'").get().n, 6);
  assert.equal(env.DB.sql.prepare('SELECT count(*) n FROM budget_changes').get().n, 0);
  const read = await call('get_budget', { session_id, view: 'proposals' }); assert.equal(read.data.proposals.length, 1);
  assert.equal((await call('approve_budget_change', { session_id, id: result.data.proposal_id })).isError, true);
});
