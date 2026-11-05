import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8791';
async function api(path, method = 'GET', body, status = 200) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(res.status, status, `${method} ${path}`);
  return res.json();
}
await api('/api/projects', 'POST', { name: '   ' }, 400);
await api('/api/projects/missing', 'PATCH', { archived: true }, 404);
const p = await api('/api/projects', 'POST', { name: '  Project <test>  ' }, 201);
assert.equal(p.name, 'Project <test>');
const path = '/api/projects/' + p.id;
await api(path, 'PATCH', { archived: 'true' }, 400);
await api(path, 'PATCH', { name: '   ' }, 400);
await api(path, 'PATCH', {}, 400);
await api(path, 'PATCH', { name: '  Renamed project  ' });
assert.equal((await api(path)).project.name, 'Renamed project');
assert.equal((await api(path)).project.short_name, 'Renamed project');
await api(path, 'PATCH', { name: 'Combined update', archived: true });
assert.equal((await api(path)).project.name, 'Combined update');
assert.equal((await api(path)).project.archived, 1);
await api('/api/tasks', 'POST', { title: 'Keep this task', project_id: p.id }, 201);
for (const archived of [true, true, false, false, true, false]) {
  await api(path, 'PATCH', { archived });
  const { projects } = await api('/api/projects');
  assert.equal(projects.some(x => x.id === p.id), !archived);
  const { tasks } = await api(path);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].project_id, p.id);
}
console.log('PASS: create, rename, combined updates, validation, archive/restore idempotency, and task preservation');
