import assert from 'node:assert/strict';
import worker from '../src/worker.js';

for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
  const path = '/api/recipes' + (['PUT', 'DELETE'].includes(method) ? '/test' : '');
  assert.equal((await worker.fetch(new Request('https://test.invalid' + path, { method }), {})).status, 401);
}
assert.equal((await worker.fetch(new Request('https://test.invalid/api/recipes', {
  method: 'POST', headers: { origin: 'https://other.invalid' },
}), { DEV_BYPASS: '1' })).status, 403);

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8791';
async function api(path, method = 'GET', body, status = 200) {
  const response = await fetch(base + '/api/recipes' + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, status, `${method} /api/recipes${path}`);
  return response.json();
}

for (const body of [null, [], {}, { name: '   ' }, { name: 1 }, { name: 'x'.repeat(151) }, { name: 'Soup', ingredients: {} }, { name: 'Soup', instructions: 'x'.repeat(30001) }]) {
  await api('', 'POST', body, 400);
}
await api('/missing', 'GET', undefined, 404);
await api('/missing', 'PUT', { name: 'Missing' }, 404);
await api('/missing', 'DELETE', undefined, 404);
const recipe = { name: '  Soup <test>  ', time: '20 min', servings: '2 servings', description: 'A test recipe', ingredients: 'Salt\n水\n<script>alert(1)</script>', instructions: 'Boil.\nServe.' };
const { id } = await api('', 'POST', recipe, 201);
try {
  let saved = (await api('/' + id)).recipe;
  assert.equal(saved.name, recipe.name.trim());
  for (const key of ['time', 'servings', 'description', 'ingredients', 'instructions']) assert.equal(saved[key], recipe[key]);
  assert.ok((await api('')).recipes.some(r => r.id === id));
  await api('/' + id, 'PUT', { name: ' ' }, 400);
  assert.equal((await api('/' + id)).recipe.ingredients, recipe.ingredients, 'Rejected writes preserve the recipe');
  await api('/' + id, 'PUT', { ...recipe, name: 'Updated soup', instructions: 'Simmer.\nServe with bread.' });
  saved = (await api('/' + id)).recipe;
  assert.equal(saved.name, 'Updated soup');
  assert.equal(saved.instructions, 'Simmer.\nServe with bread.');
  assert.equal(saved.ingredients, recipe.ingredients);
  await api('/' + id, 'PUT', { name: 'Just a name' });
  assert.equal((await api('/' + id)).recipe.ingredients, '');
} finally {
  await api('/' + id, 'DELETE');
}
await api('/' + id, 'GET', undefined, 404);
assert.ok(!(await api('')).recipes.some(r => r.id === id));
console.log('PASS: recipe authentication, origin checks, creation, persistence, updates, removal, validation, missing recipes, and multiline text');
