import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';
import { chat, processTodo } from '../src/chat.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const message = (text) => ({ type: 'message', content: [{ type: 'output_text', text }] });
const call = (name, args, id) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
const request = (path, body, token = 'test-token') => new Request('https://test.invalid' + path, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

for (const entry of ['chat', 'todo']) test(`Alfred categorizes tasks and uses Other through ${entry}`, async (t) => {
  const projects = [
    { id: 'ml', name: 'EECE 448 Applied Machine Learning', short_name: 'EECE 448' },
    { id: 'oop', name: 'EECE 476 OOP & Data Structures', short_name: 'EECE 476' },
    { id: 'career', name: 'Career Maxing', short_name: 'Career' },
  ];
  const tasks = [];
  let round = 0;
  const env = { OPENAI_API_KEY: 'mock', DB: { prepare(sql) {
    let args;
    return {
      bind(...values) { args = values; return this; },
      async all() {
        if (sql.startsWith('SELECT id, name, short_name FROM projects')) return { results: projects };
        assert.match(sql, /t.project_id IS NULL/);
        return { results: tasks.filter(x => !x.project_id).map(x => ({ ...x, project: null })) };
      },
      async first() { return tasks.find(x => x.id === args[0]); },
    };
  } } };
  const lib = {
    localNow: () => ({ date: '2026-11-05', time: '12:00' }),
    dashboard: async () => ({ allProjects: projects }), bucket: () => 'today',
    createTask: async (_env, body) => { const task = { id: `t${tasks.length + 1}`, status: 'open', ...body }; tasks.push(task); return json({ id: task.id }, 201); },
    updateTask: async (_env, id, body) => { Object.assign(tasks.find(x => x.id === id), body); return json({ ok: true }); },
  };
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.tools.find(x => x.name === 'create_task').parameters.required, ['title', 'project']);
    assert.match(body.instructions, /before creating any task or inbox to-do, call list_projects/);
    if (round++ === 0) return json({ output: [
      call('create_task', { title: 'Update resume', project: 'Career' }, '1'),
      call('list_projects', {}, '2'),
      call('create_task', { title: 'Missing classification' }, '3'),
      call('create_task', { title: 'Homework', project: 'EECE' }, '4'),
      call('create_task', { title: 'Unknown project', project: 'Missing project' }, '5'),
      call('create_task', { title: 'Gradient descent assignment', project: 'EECE 448', due_date: '2026-11-06', due_time: '14:00' }, '6'),
      call('create_task', { title: 'Update resume', project: 'Career Maxing', due_date: '2026-11-06' }, '7'),
      call('create_task', { title: 'Buy groceries', project: ' other ', due_date: '2026-11-05' }, '8'),
      call('create_task', { title: 'Someday review ML notes', project: 'EECE 448', inbox: true }, '9'),
      call('find_tasks', { project: 'Other' }, '10'),
      call('update_task', { task_id: 't1', project: 'Other' }, '11'),
    ] });
    const outputs = body.input.filter(x => x.type === 'function_call_output').map(x => JSON.parse(x.output));
    assert.match(outputs[0].error, /Call list_projects/);
    assert.equal(outputs[1].projects.length, 3);
    assert.match(outputs[2].error, /Choose a project/);
    assert.match(outputs[3].error, /Several projects match/);
    assert.match(outputs[4].error, /No project matches/);
    assert.match(outputs[5].summary, /EECE 448/);
    assert.match(outputs[6].summary, /Career/);
    assert.match(outputs[7].summary, /Other/);
    assert.equal(outputs[9].tasks.length, 1);
    assert.equal(outputs[9].tasks[0].project, 'Other');
    assert.match(outputs[10].summary, /moved to Other/);
    return json({ output: [message('Categorized the tasks.')] });
  });
  let data;
  if (entry === 'chat') {
    const response = await chat(request('/api/chat', { messages: [{ role: 'user', content: 'Add my assignments, resume work, and groceries.' }] }), env, lib);
    assert.equal(response.status, 200); data = await response.json();
  } else {
    const result = await processTodo(env, lib, { text: 'Add my assignments, resume work, and groceries.' });
    assert.equal(result.status, 200); data = result.body;
  }
  assert.equal(data.actions.length, 5);
  assert.equal(tasks.length, 4, 'Unreviewed, unclassified, ambiguous and unknown projects must not create tasks');
  assert.equal(tasks[0].project_id, null, 'Can reassign a task to Other');
  assert.equal(tasks[0].due_at, '2026-11-06T14:00');
  assert.equal(tasks[1].project_id, 'career');
  assert.equal(tasks[2].project_id, null);
  assert.equal(tasks[3].project_id, 'ml');
  assert.equal(tasks[3].kind, 'inbox');
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

test('Alfred edits recipes through shared validation and preserves unmentioned fields and complete tool results', async (t) => {
  const recipe = { id: 'r1', name: 'Rice bowl', time: '20 min', servings: '2 servings', description: 'A favourite', ingredients: '1 cup rice\n2 cups water', instructions: 'Cook the rice.\n'.repeat(1800).trim() };
  const original = { ...recipe };
  let round = 0, writes = 0;
  const env = { DEV_BYPASS: '1', OPENAI_API_KEY: 'mock', DB: { prepare(sql) {
    let args;
    return {
      bind(...values) { args = values; return this; },
      async all() {
        assert.match(sql, /SELECT id, name, time, servings, description FROM recipes WHERE name LIKE/);
        assert.deepEqual(args, ['%Rice%']);
        return { results: [{ id: recipe.id, name: recipe.name, time: recipe.time, servings: recipe.servings, description: recipe.description }] };
      },
      async first() {
        assert.equal(sql, 'SELECT * FROM recipes WHERE id = ?1');
        return args[0] === recipe.id ? { ...recipe } : null;
      },
      async run() {
        assert.match(sql, /^UPDATE recipes SET name/);
        assert.equal(args[6], 'r1');
        ['name', 'time', 'servings', 'description', 'ingredients', 'instructions'].forEach((field, i) => { recipe[field] = args[i]; });
        writes++;
        return { meta: { changes: 1 } };
      },
    };
  } } };
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.ok(body.tools.some(x => x.name === 'list_recipes'));
    assert.ok(body.tools.some(x => x.name === 'get_recipe'));
    assert.ok(body.tools.some(x => x.name === 'update_recipe'));
    assert.ok(body.tools.some(x => x.name === 'create_recipe'));
    assert.ok(body.tools.some(x => x.name === 'delete_recipe'));
    if (round++ === 0) return json({ output: [
      call('list_recipes', { query: 'Rice' }, '1'),
      call('get_recipe', { recipe_id: 'r1' }, '2'),
      call('update_recipe', { recipe_id: 'r1', name: 'Weeknight rice bowl', time: '25 min' }, '3'),
      call('update_recipe', { recipe_id: 'missing', name: 'Missing recipe' }, '4'),
      call('update_recipe', { recipe_id: 'r1', name: '   ' }, '5'),
      call('update_recipe', { recipe_id: 'r1', ingredients: null }, '6'),
      call('update_recipe', { recipe_id: 'r1', instructions: 'x'.repeat(30001) }, '7'),
      call('update_recipe', { recipe_id: 'r1', name: 'Weeknight rice bowl' }, '8'),
      call('update_recipe', { recipe_id: 'r1', description: '' }, '9'),
    ] });
    const outputs = body.input.filter(x => x.type === 'function_call_output').map(x => JSON.parse(x.output));
    assert.equal(outputs[0].recipes[0].id, 'r1');
    assert.equal(outputs[1].recipe.instructions, original.instructions, 'Long recipes must not be truncated');
    assert.equal(outputs[2].ok, true);
    assert.match(outputs[3].error, /No recipe/);
    assert.match(outputs[4].error, /name is required/);
    assert.match(outputs[5].error, /ingredients must be text/);
    assert.match(outputs[6].error, /instructions must be text/);
    assert.equal(outputs[7].summary, 'Nothing needed changing.');
    assert.equal(outputs[8].ok, true);
    return json({ output: [message('Updated your rice bowl recipe.')] });
  });
  const res = await worker.fetch(new Request('https://test.invalid/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Rename my rice bowl recipe and change the time to 25 minutes. Clear its short note.' }] }),
  }), env);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.changed, true);
  assert.equal(data.actions.length, 2);
  assert.equal(writes, 2);
  assert.deepEqual(recipe, { ...original, name: 'Weeknight rice bowl', time: '25 min', description: '' });
});

test('Alfred adds and removes recipes through the shared Worker handlers', async (t) => {
  const recipes = new Map();
  let round = 0, createdId;
  const env = { DEV_BYPASS: '1', OPENAI_API_KEY: 'mock', DB: { prepare(sql) {
    let args;
    return {
      bind(...values) { args = values; return this; },
      async first() { assert.equal(sql, 'SELECT * FROM recipes WHERE id = ?1'); return recipes.get(args[0]) || null; },
      async run() {
        if (sql.startsWith('INSERT INTO recipes')) {
          const recipe = { id: args[6] };
          ['name', 'time', 'servings', 'description', 'ingredients', 'instructions'].forEach((field, i) => { recipe[field] = args[i]; });
          recipes.set(recipe.id, recipe);
          return { meta: { changes: 1 } };
        }
        assert.equal(sql, 'DELETE FROM recipes WHERE id = ?1');
        return { meta: { changes: recipes.delete(args[0]) ? 1 : 0 } };
      },
    };
  } } };
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.tools.find(x => x.name === 'create_recipe').parameters.required, ['name']);
    assert.deepEqual(body.tools.find(x => x.name === 'delete_recipe').parameters.required, ['recipe_id']);
    assert.match(body.instructions, /delete_recipe only when they explicitly ask/);
    const outputs = body.input.filter(x => x.type === 'function_call_output').map(x => JSON.parse(x.output));
    if (round++ === 0) return json({ output: [
      call('create_recipe', { name: '   ' }, '1'),
      call('create_recipe', { name: 'Soup', ingredients: 3 }, '2'),
      call('create_recipe', { name: 'x'.repeat(151) }, '3'),
      call('create_recipe', { name: '  Lentil soup  ', servings: '4 servings', ingredients: '1 cup lentils\nWater', instructions: 'Simmer.\nServe.' }, '4'),
    ] });
    if (round === 2) {
      assert.match(outputs[0].error, /name is required/);
      assert.match(outputs[1].error, /ingredients must be text/);
      assert.match(outputs[2].error, /name must be text/);
      assert.equal(outputs[3].ok, true);
      createdId = outputs[3].id;
      assert.equal(recipes.size, 1);
      assert.deepEqual(recipes.get(createdId), { id: createdId, name: 'Lentil soup', servings: '4 servings', time: '', description: '', ingredients: '1 cup lentils\nWater', instructions: 'Simmer.\nServe.' });
      return json({ output: [
        call('get_recipe', { recipe_id: createdId }, '5'),
        call('delete_recipe', { recipe_id: createdId }, '6'),
        call('delete_recipe', { recipe_id: createdId }, '7'),
      ] });
    }
    assert.equal(outputs[4].recipe.name, 'Lentil soup');
    assert.equal(outputs[5].ok, true);
    assert.match(outputs[6].error, /No recipe with that id/);
    return json({ output: [message('Added and then removed your lentil soup recipe.')] });
  });
  const res = await worker.fetch(new Request('https://test.invalid/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Save my lentil soup recipe, then remove that recipe.' }] }),
  }), env);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.changed, true);
  assert.deepEqual(data.actions, ['Added recipe: Lentil soup', 'Removed recipe: Lentil soup']);
  assert.equal(recipes.size, 0);
});
