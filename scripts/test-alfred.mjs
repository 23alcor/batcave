import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';
import { chat } from '../src/chat.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const message = (text) => ({ type: 'message', content: [{ type: 'output_text', text }] });
const call = (name, args, id) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
const request = (path, body, token = 'test-token') => new Request('https://test.invalid' + path, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('command API authenticates, answers without creating tasks, and reports missing configuration', async (t) => {
  const env = { INGEST_TOKEN: 'test-token', OPENAI_API_KEY: 'mock-key', OPENAI_REASONING: 'off', DB: { prepare() { throw new Error('A command must not become a task'); } } };
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.input[0].content, 'What can you do?');
    return json({ output: [message('I can manage projects and tasks.')] });
  });
  assert.equal((await worker.fetch(request('/api/ingest/alfred', { text: 'What can you do?' }, 'wrong'), env)).status, 401);
  assert.equal((await worker.fetch(request('/api/ingest/alfred', { text: ' ' }), env)).status, 400);
  const res = await worker.fetch(request('/api/ingest/alfred', { text: 'What can you do?' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { handled_by: 'alfred', reply: 'I can manage projects and tasks.', actions: [], changed: false });
  const plain = await worker.fetch(new Request('https://test.invalid/api/ingest/alfred?format=text', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: 'What can you do?' }), env);
  assert.equal(await plain.text(), 'I can manage projects and tasks.');
  assert.equal((await worker.fetch(request('/api/ingest/alfred', { text: 'Help' }), { ...env, OPENAI_API_KEY: '' })).status, 503);
});

test('command failures do not create inbox tasks; todo fallback still does', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Mock unavailable'); });
  let writes = 0;
  const env = { INGEST_TOKEN: 'test-token', OPENAI_API_KEY: 'mock-key', DB: { prepare(sql) {
    assert.match(sql, /INSERT INTO tasks/);
    return { bind() { return this; }, async run() { writes++; return {}; } };
  } } };
  const failed = await worker.fetch(request('/api/ingest/alfred', { text: 'Rename a project' }), env);
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).changed, false);
  assert.equal(writes, 0);
  const todo = await worker.fetch(request('/api/ingest/todo', { text: 'Buy paper', alfred: false }), env);
  assert.equal(todo.status, 201);
  assert.equal((await todo.json()).handled_by, 'inbox');
  assert.equal(writes, 1);
});

test('Alfred project tools create, rename, archive, restore, and expose archived ids', async (t) => {
  let project = null, round = 0;
  const lib = {
    localNow: () => ({ date: '2026-11-03', time: '12:00' }),
    createProject: async (_env, body) => { project = { id: 'p1', name: body.name, archived: 0 }; return json(project, 201); },
    updateProject: async (_env, id, body) => {
      assert.equal(id, 'p1');
      Object.assign(project, body);
      return json({ ok: true });
    },
  };
  const env = { OPENAI_API_KEY: 'mock', DB: { prepare(sql) {
    return { bind(id) { assert.equal(id, 'p1'); return this; }, async first() { return project; }, async all() { assert.match(sql, /FROM projects ORDER BY sort/); return { results: [project] }; } };
  } } };
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.ok(body.tools.some(x => x.name === 'create_project'));
    assert.ok(body.tools.some(x => x.name === 'update_project'));
    if (round++ === 0) return json({ output: [
      call('create_project', { name: 'Robotics' }, '1'),
      call('update_project', { project_id: 'p1', name: 'Senior Design' }, '2'),
      call('update_project', { project_id: 'p1', archived: true }, '3'),
      call('list_projects', { include_archived: true }, '4'),
      call('update_project', { project_id: 'p1', archived: false }, '5'),
      call('update_project', { project_id: 'p1', archived: false }, '6'),
    ] });
    const outputs = body.input.filter(x => x.type === 'function_call_output');
    assert.equal(JSON.parse(outputs[3].output).projects[0].id, 'p1');
    assert.equal(JSON.parse(outputs[3].output).projects[0].archived, true);
    assert.equal(JSON.parse(outputs[5].output).summary, 'Nothing needed changing.');
    return json({ output: [message('Updated the project.')] });
  });
  const res = await chat(request('/api/chat', { messages: [{ role: 'user', content: 'Manage the project' }] }), env, lib);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.actions.length, 4);
  assert.equal(data.changed, true);
  assert.equal(project.name, 'Senior Design');
  assert.equal(project.archived, false);
});
