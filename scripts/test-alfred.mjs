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

test('Alfred receives duration clarification guidance and keeps the answer in chat history', async (t) => {
  const question = 'Roughly how long will this take, or should we plan a first work session?';
  let round = 0;
  const env = { OPENAI_API_KEY: 'mock' };
  const lib = {
    localNow: () => ({ date: '2026-11-11', time: '12:00' }),
    addDays: (date) => date,
    events: async () => ({ events: [
      { title: 'Class', start: '2026-11-12T10:00', end: '2026-11-12T11:00' },
      { title: 'Work', start: '2026-11-12T12:00', end: '2026-11-12T14:00' },
    ], deadlines: [] }),
  };
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.match(body.instructions, /Use any duration already given in the conversation or task notes/);
    assert.match(body.instructions, /ask one brief question before calling find_free_time or saving a chosen work time/);
    assert.match(body.instructions, /do not delay saving an explicitly timed task/);
    assert.match(body.instructions, /do not imply one session will finish a larger task/);
    assert.match(body.instructions, /If no suitable window fits/);
    if (round++ === 0) return json({ output: [message(question)] });
    assert.equal(body.input[1].content, question);
    assert.equal(body.input[2].content, 'It needs a two-hour first session tomorrow.');
    if (round === 2) return json({ output: [call('find_free_time', { minutes: 120, start_date: '2026-11-12', days: 1, day_start: '08:00', day_end: '17:00' }, 'duration')] });
    const result = JSON.parse(body.input.find(x => x.type === 'function_call_output').output);
    assert.equal(result.minutes_needed, 120);
    assert.deepEqual(result.days[0].free, [{ start: '14:15', end: '17:00', minutes: 165 }]);
    return json({ output: [message('A two-hour first session fits tomorrow at 2:15 PM.')] });
  });
  const history = [{ role: 'user', content: 'When should I work on my project?' }];
  const first = await (await chat(request('/api/chat', { messages: history }), env, lib)).json();
  assert.equal(first.reply, question);
  assert.equal(first.changed, false);
  const second = await (await chat(request('/api/chat', { messages: [...history, { role: 'assistant', content: first.reply }, { role: 'user', content: 'It needs a two-hour first session tomorrow.' }] }), env, lib)).json();
  assert.match(second.reply, /two-hour first session/);
  assert.equal(second.changed, false, 'A recommendation alone must not create or change a task');
});

test('one-way to-do API receives an unscheduled fallback for ambiguous durations', async (t) => {
  let saved;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const { instructions } = JSON.parse(opts.body);
    assert.match(instructions, /owner cannot answer follow-up questions/);
    assert.match(instructions, /save it without choosing a work time: preserve any explicit deadline, otherwise use the inbox/);
    assert.match(instructions, /Duration needs clarification before scheduling/);
    return json({ output: [message('This task still needs a duration.')] });
  });
  const result = await processTodo({ OPENAI_API_KEY: 'mock' }, {
    localNow: () => ({ date: '2026-11-11', time: '12:00' }),
    createTask: async (_env, body) => { saved = body; return json({ id: 'unscheduled' }, 201); },
  }, { text: 'Work on my project', notes: 'Keep these notes' });
  assert.equal(result.status, 200);
  assert.equal(saved.kind, 'inbox');
  assert.equal(saved.due_at, undefined);
  assert.equal(saved.notes, 'Keep these notes');
  assert.match(result.body.reply, /needs a duration/);
});

test('preview visitors cannot call Alfred, including when the local owner bypass is enabled', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Preview must not call the model'); });
  const env = { DEV_BYPASS: '1', OPENAI_API_KEY: 'mock', DB: { prepare() { throw new Error('Preview chat must not access data'); } } };
  for (const path of ['/api/chat', '/api/chat/']) {
    const response = await worker.fetch(new Request('https://test.invalid' + path, {
      method: 'POST', headers: { cookie: 'bc_demo=1', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Add a task' }] }),
    }), env);
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /preview/);
  }
  assert.equal(upstream.mock.callCount(), 0);
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

test('Alfred manages restaurants and dated visits through the shared Eating Out handlers', async (t) => {
  const mutations = [];
  const env = { DEV_BYPASS: '1', OPENAI_API_KEY: 'mock', DB: { prepare(sql) {
    let args;
    return { bind(...values) { args = values; return this; },
      async first() { return 'shared-list'; },
      async all() {
        if (sql.startsWith('SELECT * FROM places')) return { results: [{ id: 'place', name: 'Kyan' }] };
        if (sql.includes('FROM place_dishes')) return { results: [{ id: 'dish', place_id: 'place', name: 'Coffee', day: '2026-11-01' }] };
        return { results: [{ uid: 0 }] };
      },
      async run() { mutations.push({ sql, args }); return { meta: { changes: 1 } }; },
    };
  }, async batch(statements) { return Promise.all(statements.map(s => s.run())); } } };
  let round = 0;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.ok(body.tools.some(tool => tool.name === 'manage_restaurant'));
    if (round++ === 0) return json({ output: [
      call('list_eating_out', {}, 'list'),
      call('manage_restaurant', { action: 'add', name: 'Cafe', cuisine: 'Coffee' }, 'add'),
      call('manage_restaurant', { action: 'edit', place_id: 'place', area: 'Bronx' }, 'edit'),
      call('manage_dish', { action: 'add', place_id: 'place', name: 'Tea', date: '2026-11-02' }, 'visit'),
      call('manage_dish', { action: 'edit', dish_id: 'dish', date: '2026-11-03' }, 'date'),
      call('manage_dish', { action: 'edit', dish_id: 'dish', date: '2026-02-30' }, 'invalid'),
      call('manage_dish', { action: 'remove', dish_id: 'foreign' }, 'foreign'),
      call('manage_dish', { action: 'remove', dish_id: 'dish' }, 'remove'),
      call('manage_restaurant', { action: 'remove', place_id: 'place' }, 'delete'),
    ] });
    const outputs = body.input.filter(x => x.type === 'function_call_output').map(x => JSON.parse(x.output));
    assert.match(outputs[5].error, /valid date/);
    assert.match(outputs[6].error, /not found/);
    return json({ output: [message('Updated Eating Out.')] });
  });
  const response = await worker.fetch(new Request('https://test.invalid/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Manage my restaurants and visit dates' }] }) }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).actions.length, 6);
  assert.equal(mutations.length, 7);
  assert.ok(mutations.some(x => x.args.includes('2026-11-03')));
});

test('Alfred retains task date and calendar add/edit/remove tools', async (t) => {
  const writes = [];
  let round = 0;
  const lib = { localNow: () => ({ date: '2026-11-06', time: '12:00' }), google: {
    state: async () => ({ connected: true }),
    createEvent: async (_env, args) => { writes.push(['add', args]); return { summary: 'Added event' }; },
    updateEvent: async (_env, args) => { writes.push(['edit', args]); return { summary: 'Moved event' }; },
    cancelEvent: async (_env, args) => { writes.push(['remove', args]); return { summary: 'Removed event' }; },
  } };
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.ok(body.tools.find(x => x.name === 'update_task').parameters.properties.clear_due_date);
    if (round++ === 0) return json({ output: [
      call('create_event', { title: 'Dinner', date: '2026-11-07', start_time: '18:00' }, 'add'),
      call('update_event', { event_id: 'event', calendar_id: 'calendar', date: '2026-11-08' }, 'edit'),
      call('cancel_event', { event_id: 'event', calendar_id: 'calendar' }, 'remove'),
    ] });
    return json({ output: [message('Updated the calendar.')] });
  });
  const response = await chat(request('/api/chat', { messages: [{ role: 'user', content: 'Add, move and remove my dinner event' }] }), { OPENAI_API_KEY: 'mock' }, lib);
  assert.equal((await response.json()).actions.length, 3);
  assert.deepEqual(writes.map(x => x[0]), ['add', 'edit', 'remove']);
  assert.equal(writes[1][1].date, '2026-11-08');
});
