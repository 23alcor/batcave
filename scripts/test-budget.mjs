import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { budgetApi } from '../src/budget.js';
import { budgetPeriod, personalSpending, shareRemaining, subscriptionCalendar, parseBudgetMoney, summarizeBudget } from '../public/budget-core.js';
import { parseBudgetCSV, budgetImportRows } from '../public/budget-csv.js';
import { BUDGET_TOOLS } from '../src/budget-tools.js';
import worker from '../src/worker.js';
import { makeTools, chat } from '../src/chat.js';

function setup(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0017_budget.sql', import.meta.url), 'utf8'));
  t.after(() => sql.close());
  const prepare = (query, params = []) => {
    function statement() {
      const ordered = []; const converted = query.replace(/\?(\d+)/g, (_, n) => { ordered.push(params[+n - 1]); return '?'; });
      return [sql.prepare(converted), ordered];
    }
    return { bind: (...args) => prepare(query, args), async first(column) { const [s, p] = statement(), row = s.get(...p); return column ? row?.[column] ?? null : row ?? null; }, async all() { const [s, p] = statement(); return { results: s.all(...p) }; }, async run() { const [s, p] = statement(); return { meta: { changes: Number(s.run(...p).changes) } }; } };
  };
  const env = { DB: { prepare, async batch(statements) { sql.exec('BEGIN'); try { const result = []; for (const stmt of statements) result.push(await stmt.run()); sql.exec('COMMIT'); return result; } catch (e) { sql.exec('ROLLBACK'); throw e; } } } };
  const call = async (path = '', body, actor = 'user', method = body === undefined ? 'GET' : 'POST') => {
    const response = await budgetApi(new Request('https://test.invalid/api/budget' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, '/api/budget' + path, '2026-11-11', actor);
    return { status: response.status, ...await response.json() };
  };
  const save = change => call('/changes', { ...change, request_id: change.request_id || crypto.randomUUID() });
  const create = (resource, fields) => save({ resource, action: 'create', fields });
  const update = (r, action, fields = {}) => save({ resource: r.kind, action, id: r.id, version: r.version, fields });
  return { sql, call, save, create, update, env };
}
const expense = (fields = {}) => ({ name: 'Dinner', amount: 10000, date: '2026-11-10', category_id: 'budget-dining', status: 'tracked', ...fields });

test('one saved amount drives both periods, with cents rounding and effective-date history', () => {
  const category = { id: 'food', kind: 'category', data: { name: 'Food' } };
  const limit = (id, period, start_date, amount, updated_at) => ({ id, kind: 'limit', data: { category_id: 'food', period, start_date, amount }, updated_at });
  const october = limit('october', 'monthly', '2026-10-01', 20000, '2026-10-01T00:00:00Z');
  const monthly = limit('november', 'monthly', '2026-11-01', 70000, '2026-11-01T00:00:00Z');
  const records = [category, october, monthly];
  const totals = date => ['monthly', 'weekly'].map(period => summarizeBudget(records, date, period).budget);
  assert.deepEqual(totals('2026-11-11'), [70000, 16154]); // $700/month is $161.54/week.
  const weekly = limit('week', 'weekly', '2026-11-09', 10000, '2026-11-11T00:00:00Z');
  records.push(weekly);
  assert.deepEqual(totals('2026-11-11'), [43333, 10000]); // $100/week is $433.33/month.
  assert.deepEqual(totals('2026-10-15'), [20000, 4615]);
  monthly.data.amount = 52000; monthly.updated_at = '2026-11-11T00:01:00Z';
  assert.deepEqual(totals('2026-11-11'), [52000, 12000]);
  records.push(limit('future', 'monthly', '2026-12-01', 65000, '2026-11-11T00:02:00Z'));
  assert.deepEqual(totals('2026-11-11'), [52000, 12000]);
  assert.deepEqual(totals('2026-12-05'), [65000, 15000]);
  weekly.data.amount = 0; weekly.updated_at = '2026-11-11T00:03:00Z';
  assert.deepEqual(totals('2026-11-11'), [0, 0]);
  weekly.archived = true;
  assert.deepEqual(totals('2026-11-11'), [52000, 12000]);
  october.updated_at = '2026-11-11T00:04:00Z'; // Editing an older month cannot replace November's saved limit.
  assert.deepEqual(totals('2026-11-11'), [52000, 12000]);
  assert.deepEqual(totals('2026-09-15'), [0, 0]);
});

test('saving either budget cadence updates both API views without creating converted records', async t => {
  const { call, create, update } = setup(t);
  const monthly = (await create('limit', { category_id: 'budget-dining', period: 'monthly', amount: 52000 })).record;
  assert.equal((await call()).weekly.budget, 12000);
  await create('limit', { category_id: 'budget-dining', period: 'weekly', amount: 10000 });
  assert.equal((await call()).monthly.budget, 43333);
  await update(monthly, 'update', { amount: 65000 });
  const result = await call();
  assert.equal(result.monthly.budget, 65000); assert.equal(result.weekly.budget, 15000);
  assert.equal(result.records.filter(record => record.kind === 'limit').length, 2);
});

test('empty budget, linked period limits, and integer money validation', async t => {
  const { call, create } = setup(t);
  const empty = await call(); assert.equal(empty.records.length, 6); assert.equal(empty.monthly.spent, 0); assert.equal(empty.bank_connected, false);
  await create('limit', { category_id: 'budget-dining', period: 'monthly', start_date: '2026-11-01', amount: 30000 });
  await create('limit', { category_id: 'budget-dining', period: 'monthly', start_date: '2026-10-01', amount: 20000 });
  await create('limit', { category_id: 'budget-dining', period: 'weekly', amount: 10000 });
  const snapshot = await call(); assert.equal(snapshot.monthly.budget, 43333); assert.equal(snapshot.weekly.budget, 10000);
  assert.equal(summarizeBudget(snapshot.records, '2026-12-05').budget, 43333);
  assert.equal(summarizeBudget(snapshot.records, '2026-10-05').budget, 20000);
  assert.equal(summarizeBudget(snapshot.records, '2026-09-05').budget, 0);
  assert.deepEqual(budgetPeriod('2026-11-11', 'weekly'), { start: '2026-11-09', end: '2026-11-15', days: 7, elapsed: 3 });
  assert.equal(parseBudgetMoney('10.01'), 1001);
  for (const value of ['-1', '1.001', 'NaN', '1e3']) assert.throws(() => parseBudgetMoney(value));
  for (const fields of [{ amount: -1 }, { amount: 1.1 }, { amount: 100000001 }, { date: '2026-02-30' }, { date: '2027-01-01' }, { shares: [null] }, { category_id: 'someone-elses-id' }, { settlements: [] }]) {
    const result = await create('transaction', expense(fields)); assert.ok([400, 404].includes(result.status), JSON.stringify(result));
  }
  assert.equal((await call()).monthly.spent, 0);
});

test('outing repayments and forgiveness preserve personal spending and cannot overpay', async t => {
  const { create, update, call } = setup(t);
  let r = (await create('transaction', expense({ shares: [{ name: 'Alex', amount: 5000 }, { name: 'Sam', amount: 2500 }] }))).record;
  assert.equal(personalSpending(r.data), 2500);
  const share = r.data.shares[0].id;
  r = (await update(r, 'repay', { share_id: share, amount: 2000, date: '2026-11-11', method: 'Zelle' })).record;
  assert.equal(personalSpending(r.data), 2500); assert.equal(shareRemaining(r.data, share), 3000);
  assert.equal((await update(r, 'repay', { share_id: share, amount: 3001, date: '2026-11-11', method: 'cash' })).status, 400);
  assert.equal((await update(r, 'update', { shares: [] })).status, 400);
  assert.equal((await update(r, 'update', { status: 'ignored' })).status, 400);
  r = (await update(r, 'forgive', { share_id: share, amount: 3000, date: '2026-11-11' })).record;
  assert.equal(personalSpending(r.data), 5500); assert.equal(shareRemaining(r.data, share), 0);
  assert.equal((await call()).monthly.spent, 5500);
  assert.equal((await update(r, 'forgive', { share_id: share, amount: 1, date: '2026-11-11' })).status, 400);
});

test('edits are versioned, audited, idempotent and reversible without overwriting later edits', async t => {
  const { create, update, call, save, sql } = setup(t);
  const original = { resource: 'transaction', action: 'create', fields: expense(), request_id: 'fixed-request-123' };
  const first = await save(original); assert.equal(first.status, 200);
  assert.equal((await save(original)).replayed, true);
  assert.equal((await save({ ...original, fields: expense({ amount: 1 }) })).status, 409);
  const r = first.record, edited = await update(r, 'update', { name: 'Outing dinner' });
  assert.equal((await update(r, 'update', { name: 'Stale edit' })).status, 409);
  assert.equal((await call(`/history/${first.change_id}/undo`, { request_id: crypto.randomUUID() })).status, 409);
  let undo = await call(`/history/${edited.change_id}/undo`, { request_id: 'undo-dinner-123' });
  assert.equal(undo.record.data.name, 'Dinner'); assert.equal(undo.record.version, 3);
  assert.equal((await call(`/history/${edited.change_id}/undo`, { request_id: 'undo-dinner-123' })).replayed, true);
  const archived = await update(undo.record, 'archive'); assert.equal((await call()).monthly.spent, 0);
  const restored = await update(archived.record, 'restore'); assert.equal(restored.record.archived, false); assert.equal((await call()).monthly.spent, 10000);
  assert.equal(sql.prepare('SELECT count(*) n FROM budget_records WHERE kind=\'transaction\'').get().n, 1);
  assert.equal((await call('', undefined, 'user', 'DELETE')).status, 405);
});

test('Alfred can only propose one validated change; approval is explicit, stable and single use', async t => {
  const { call, sql } = setup(t);
  const change = { resource: 'transaction', action: 'create', fields: expense(), reason: 'You asked to record dinner.' };
  for (const path of ['/changes', '/proposals/missing/approve', '/history/missing/undo']) assert.equal((await call(path, { ...change, request_id: 'forbidden-request' }, 'alfred')).status, 403);
  assert.equal((await call('', undefined, 'alfred', 'DELETE')).status, 403);
  for (const action of ['delete', 'delete_all', 'reset']) assert.equal((await call('/proposals', { ...change, action }, 'alfred')).status, 400);
  assert.equal((await call('/proposals', [change, change], 'alfred')).status, 400);
  const proposal = await call('/proposals', change, 'alfred'); assert.equal(proposal.status, 'pending');
  assert.equal((await call()).monthly.spent, 0);
  const approved = await call(`/proposals/${proposal.proposal_id}/approve`, {});
  assert.equal(approved.status, 200); assert.equal(approved.record.id, proposal.after.id);
  assert.equal((await call(`/proposals/${proposal.proposal_id}/approve`, {})).already_approved, true);
  assert.equal((await call()).monthly.spent, 10000);
  assert.equal(sql.prepare('SELECT actor FROM budget_changes').get().actor, 'alfred');
  assert.deepEqual(BUDGET_TOOLS.map(t => t.name), ['get_budget', 'propose_budget_change']);
});

test('stale, expired and rejected Alfred proposals never change records', async t => {
  const { call, create, update, sql } = setup(t);
  const r = (await create('transaction', expense())).record;
  const proposal = () => call('/proposals', { resource: r.kind, action: 'update', id: r.id, version: r.version, fields: { amount: 15000 }, reason: 'Requested correction' }, 'alfred');
  const stale = await proposal(); await update(r, 'update', { name: 'New name' });
  assert.equal((await call(`/proposals/${stale.proposal_id}/approve`, {})).status, 409);
  const change = { resource: 'category', action: 'create', fields: { name: 'Books' }, reason: 'New category' };
  const expired = await call('/proposals', change, 'alfred'); sql.prepare('UPDATE budget_proposals SET expires_at=? WHERE id=?').run('2000-01-01', expired.proposal_id);
  assert.equal((await call(`/proposals/${expired.proposal_id}/approve`, {})).status, 409);
  const rejected = await call('/proposals', change, 'alfred'); await call(`/proposals/${rejected.proposal_id}/reject`, {});
  assert.equal((await call(`/proposals/${rejected.proposal_id}/approve`, {})).status, 409);
  assert.equal((await call()).records.filter(r => r.kind === 'category').length, 6);
  assert.equal((await call()).monthly.spent, 10000);
});

test('duplicate constraints roll back edits and their audits together; current refs block category archive', async t => {
  const { call, create, update, sql } = setup(t);
  const first = (await create('category', { name: 'Books' })).record;
  const second = (await create('category', { name: 'Hobbies' })).record;
  const audits = sql.prepare('SELECT count(*) n FROM budget_changes').get().n;
  assert.equal((await update(second, 'update', { name: 'Books' })).status, 409);
  assert.equal(sql.prepare('SELECT count(*) n FROM budget_changes').get().n, audits);
  assert.equal((await call()).records.find(r => r.id === second.id).data.name, 'Hobbies');
  await create('transaction', expense({ category_id: first.id }));
  assert.equal((await update(first, 'archive')).status, 400);
});

test('annual and short-month subscriptions schedule without phantom spending; charges are counted once', async t => {
  const { call, create, update } = setup(t);
  const annual = (await create('subscription', { name: 'Annual plan', amount: 12000, category_id: 'budget-subscriptions', start_date: '2024-02-29', cycle: 'yearly', method: 'Visa' })).record;
  assert.equal((await call()).monthly.spent, 0);
  assert.equal(subscriptionCalendar([annual], [], '2025-02-01', '2025-02-28')[0].date, '2025-02-28');
  assert.equal(subscriptionCalendar([annual], [], '2025-03-01', '2025-03-31').length, 0);
  const monthly = (await create('subscription', { name: 'Monthly plan', amount: 2000, category_id: 'budget-subscriptions', start_date: '2026-01-31', cycle: 'monthly' })).record;
  assert.equal(subscriptionCalendar([monthly], [], '2026-02-01', '2026-02-28')[0].date, '2026-02-28');
  const sub = (await create('subscription', { name: 'Music', amount: 1000, category_id: 'budget-subscriptions', start_date: '2026-11-10', cycle: 'monthly' })).record;
  const fields = expense({ name: 'Music charge', amount: 1000, category_id: sub.data.category_id, subscription_id: sub.id, billing_date: '2026-11-10' });
  const paid = await create('transaction', fields); assert.equal(paid.status, 200);
  assert.equal((await create('transaction', fields)).status, 409);
  assert.equal((await create('transaction', { ...fields, billing_date: '2026-11-11' })).status, 400);
  assert.equal((await call()).monthly.spent, 1000);
  const paused = (await update(sub, 'update', { active: false })).record;
  assert.equal(subscriptionCalendar([paused], [paid.record], '2026-11-01', '2026-11-30')[0].status, 'paid');
  assert.equal(subscriptionCalendar([paused], [], '2026-12-01', '2026-12-31').length, 0);
});

test('CSV accepts quoted names, rejects malformed money, and deduplicates repeat imports including same-day duplicates', async t => {
  const { call, create, update } = setup(t);
  const csv = 'date,name,amount,category\r\n2026-11-10,"Dinner, friends",10.01,Dining out\r\n2026-11-10,"Dinner, friends",10.01,Dining out\r\n';
  const parsed = parseBudgetCSV(csv); assert.equal(parsed[0].name, 'Dinner, friends');
  const rows = await budgetImportRows(parsed, (await call()).records);
  assert.notEqual(rows[0].external_id, rows[1].external_id);
  assert.deepEqual(rows, await budgetImportRows(parseBudgetCSV(csv), (await call()).records));
  for (const fields of rows) assert.equal((await create('transaction', fields)).status, 200);
  for (const fields of rows) assert.equal((await create('transaction', fields)).status, 409);
  let snapshot = await call(); assert.equal(snapshot.monthly.spent, 0); assert.equal(snapshot.monthly.review_count, 2);
  const record = snapshot.records.find(r => r.kind === 'transaction');
  assert.equal((await update(record, 'update', { amount: 100 })).status, 400);
  assert.equal((await update(record, 'update', { status: 'tracked' })).status, 200);
  assert.equal((await call()).monthly.spent, 1001);
  for (const bad of ['date,name,amount\n2026-02-30,Thing,1', 'date,name,amount\n2026-11-10,Thing,-1', 'date,name,amount\n2026-11-10,"Unclosed,1', 'name,amount\nThing,1']) assert.throws(() => parseBudgetCSV(bad));
});

test('separate user databases cannot access another user’s records or proposals; unauthenticated API is blocked', async t => {
  const a = setup(t), b = setup(t);
  const r = (await a.create('transaction', expense())).record;
  assert.equal((await b.update(r, 'update', { amount: 1 })).status, 404);
  const p = await a.call('/proposals', { resource: r.kind, action: 'update', id: r.id, version: r.version, fields: { amount: 100 }, reason: 'Private edit' }, 'alfred');
  assert.equal((await b.call(`/proposals/${p.proposal_id}/approve`, {})).status, 404);
  assert.equal((await b.call()).monthly.spent, 0);
  assert.equal((await worker.fetch(new Request('https://test.invalid/api/budget'), {})).status, 401);
});

test('confirmed charges remain editable after a subscription schedule or category changes', async t => {
  const { create, update } = setup(t);
  const sub = (await create('subscription', { name: 'Music', amount: 1000, category_id: 'budget-subscriptions', start_date: '2026-11-10', cycle: 'monthly' })).record;
  const payment = (await create('transaction', expense({ name: 'Music', category_id: sub.data.category_id, subscription_id: sub.id, billing_date: '2026-11-10' }))).record;
  await update(sub, 'update', { billing_day: 15, category_id: 'budget-other' });
  const edit = await update(payment, 'update', { name: 'Original music charge' }); assert.equal(edit.status, 200);
  assert.equal((await update(edit.record, 'archive')).status, 200);
});

test('a proposal rejected between validation and commit cannot be applied', async t => {
  const { call, env, sql } = setup(t);
  const p = await call('/proposals', { resource: 'category', action: 'create', fields: { name: 'Books' }, reason: 'Requested' }, 'alfred');
  const batch = env.DB.batch;
  env.DB.batch = async statements => { sql.prepare("UPDATE budget_proposals SET status='rejected' WHERE id=?").run(p.proposal_id); return batch(statements); };
  assert.equal((await call(`/proposals/${p.proposal_id}/approve`, {})).status, 409);
  assert.equal(sql.prepare("SELECT count(*) n FROM budget_records WHERE kind='category'").get().n, 6);
  assert.equal(sql.prepare('SELECT count(*) n FROM budget_changes').get().n, 0);
});

test('worker blocks cross-site and demo writes before budget access', async () => {
  const env = { DEV_BYPASS: '1', DB: { prepare() { throw new Error('Must not access DB'); } } };
  const request = headers => new Request('https://test.invalid/api/budget/changes', { method: 'POST', headers, body: '{}' });
  assert.equal((await worker.fetch(request({ origin: 'https://evil.invalid' }), env)).status, 403);
  assert.equal((await worker.fetch(request({ cookie: 'bc_demo=1' }), env)).status, 403);
});


test('Alfred registered tools read current versions and return proposals without mutating budget totals', async t => {
  const { env, call, create } = setup(t), actions = [];
  const r = (await create('transaction', expense())).record;
  const tools = makeTools(env, { localNow: () => ({ date: '2026-11-11', time: '12:00' }) }, actions);
  const found = await tools.get_budget({ view: 'transactions', query: 'dinner' }); assert.equal(found.records[0].version, r.version);
  const proposal = await tools.propose_budget_change({ resource: r.kind, action: 'update', id: r.id, version: r.version, fields: { amount: 20000 }, reason: 'Requested correction' });
  assert.equal(proposal.status, 'pending'); assert.equal((await call()).monthly.spent, 10000);
  assert.match(actions[0], /unchanged/);
  await assert.rejects(tools.propose_budget_change({ resource: r.kind, action: 'delete_all', fields: {}, reason: 'Misunderstood request' }), /Bulk operations/);
  assert.equal(tools.approve_budget_change, undefined);
});

test('a competing edit between validation and commit causes no partial write or audit', async t => {
  const { env, create, update, sql } = setup(t);
  const r = (await create('transaction', expense())).record, batch = env.DB.batch;
  env.DB.batch = async statements => { sql.prepare('UPDATE budget_records SET version=version+1 WHERE id=?').run(r.id); return batch(statements); };
  const result = await update(r, 'update', { amount: 5000 }); assert.equal(result.status, 409);
  assert.equal(sql.prepare('SELECT count(*) n FROM budget_changes').get().n, 1);
  assert.equal(JSON.parse(sql.prepare('SELECT data FROM budget_records WHERE id=?').get(r.id).data).amount, 10000);
});


test('budget creates accept omitted or null metadata; edits still require a real id and version', async t => {
  const { call, create } = setup(t);
  const change = { resource: 'transaction', action: 'create', fields: expense({ name: 'Dunkin', amount: 1472, date: '2026-11-11' }), reason: 'Spent $14.72 at Dunkin today' };
  for (const metadata of [{}, { id: null, version: null }]) {
    const result = await call('/proposals', { ...change, ...metadata }, 'alfred'); assert.equal(result.status, 'pending'); assert.equal(result.after.data.amount, 1472);
  }
  for (const metadata of [{ id: 'invented-id' }, { version: 0 }, { version: 1 }]) assert.equal((await call('/proposals', { ...change, ...metadata }, 'alfred')).status, 400);
  const r = (await create('transaction', expense())).record;
  assert.equal((await call('/proposals', { resource: 'transaction', action: 'update', id: r.id, version: null, fields: { amount: 1472 }, reason: 'Correction' }, 'alfred')).status, 409);
  assert.equal((await call()).monthly.spent, 10000);
});

test('chat sends optional budget schemas explicitly non-strict and prepares the Dunkin proposal without adding spending', async t => {
  const { env, call } = setup(t);
  env.OPENAI_API_KEY = 'mock'; let round = 0;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    for (const name of ['get_budget', 'propose_budget_change']) assert.equal(body.tools.find(tool => tool.name === name).strict, false);
    const tool = body.tools.find(tool => tool.name === 'propose_budget_change');
    assert.ok(!tool.parameters.required.includes('id')); assert.ok(!tool.parameters.required.includes('version'));
    if (round++ === 0) return new Response(JSON.stringify({ output: [{ type: 'function_call', name: 'propose_budget_change', call_id: 'dunkin', arguments: JSON.stringify({ resource: 'transaction', action: 'create', id: null, version: null, fields: { name: 'Dunkin', amount: 1472, date: '2026-11-11', category_id: 'budget-dining', status: 'tracked' }, reason: 'Record the $14.72 spent at Dunkin today.' }) }] }));
    const output = JSON.parse(body.input.find(item => item.type === 'function_call_output').output);
    assert.equal(output.status, 'pending'); assert.equal(output.after.data.amount, 1472);
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Prepared $14.72 at Dunkin for your approval in Budget.' }] }] }));
  });
  const response = await chat(new Request('https://test.invalid/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi alfred add that I spent 14.72 at Dunkin today' }] }) }), env, { localNow: () => ({ date: '2026-11-11', time: '12:00' }) });
  assert.equal(response.status, 200); assert.match((await response.json()).reply, /approval/);
  const data = await call(); assert.equal(data.monthly.spent, 0); assert.equal(data.proposals.length, 1); assert.equal(data.proposals[0].after.data.amount, 1472);
});

test('permanent deletion requires confirmation, archive state and current version; retries never recreate records', async t => {
  const { call, save, update, sql } = setup(t);
  const createRequest = { resource: 'transaction', action: 'create', fields: expense(), request_id: 'expense-delete-test' };
  const created = await save(createRequest), record = created.record;
  const remove = (r, extra = {}) => call('/records/' + r.id, { version: r.version, request_id: 'delete-expense-123', confirm: true, ...extra }, 'user', 'DELETE');
  assert.equal((await remove(record)).status, 409);
  const archived = (await update(record, 'archive')).record;
  assert.equal((await remove(archived, { confirm: false })).status, 400);
  assert.equal((await remove(archived, { version: record.version })).status, 409);
  const result = await remove(archived); assert.equal(result.status, 200); assert.equal(result.record.deleted, true);
  assert.equal(sql.prepare('SELECT count(*) n FROM budget_records WHERE id=?').get(record.id).n, 0);
  assert.equal((await remove(archived)).replayed, true);
  assert.equal((await save(createRequest)).replayed, true);
  assert.equal(sql.prepare('SELECT count(*) n FROM budget_records WHERE id=?').get(record.id).n, 0);
  assert.equal((await call('/history/' + result.change_id + '/undo', { request_id: 'undo-deletion-123' })).status, 410);
  assert.equal((await call('/history/' + created.change_id + '/undo', { request_id: 'undo-deleted-create' })).status, 404);
  const other = setup(t);
  assert.equal((await other.call('/records/' + record.id, { version: archived.version, request_id: 'other-user-delete', confirm: true }, 'user', 'DELETE')).status, 404);
});

test('archived references block category and subscription deletion until their dependents are deleted', async t => {
  const { call, create, update } = setup(t);
  const category = (await create('category', { name: 'Archive test' })).record;
  const limit = (await create('limit', { category_id: category.id, period: 'monthly', amount: 10000 })).record;
  const archivedLimit = (await update(limit, 'archive')).record;
  const archivedCategory = (await update(category, 'archive')).record;
  const remove = r => call('/records/' + r.id, { version: r.version, request_id: crypto.randomUUID(), confirm: true }, 'user', 'DELETE');
  assert.equal((await remove(archivedCategory)).status, 409);
  assert.equal((await call()).monthly.categories.some(c => c.id === category.id), false);
  assert.equal((await remove(archivedLimit)).status, 200);
  assert.equal((await remove(archivedCategory)).status, 200);
  const sub = (await create('subscription', { name: 'Test subscription', amount: 2000, category_id: 'budget-subscriptions', start_date: '2026-11-01', cycle: 'monthly' })).record;
  const charge = (await create('transaction', expense({ subscription_id: sub.id, billing_date: '2026-11-01', category_id: 'budget-subscriptions' }))).record;
  const archivedCharge = (await update(charge, 'archive')).record;
  const archivedSub = (await update(sub, 'archive')).record;
  assert.equal((await remove(archivedSub)).status, 409);
  assert.equal((await remove(archivedCharge)).status, 200);
  assert.equal((await remove(archivedSub)).status, 200);
});

test('pending references block permanent deletion; Alfred cannot delete or propose permanent deletion', async t => {
  const { call, create, update, sql } = setup(t);
  const category = (await create('category', { name: 'Proposal category' })).record;
  const proposal = await call('/proposals', { resource: 'transaction', action: 'create', fields: expense({ category_id: category.id }), reason: 'Pending expense' }, 'alfred');
  const archived = (await update(category, 'archive')).record;
  const body = { version: archived.version, confirm: true, request_id: 'delete-pending-ref' };
  assert.equal((await call('/records/' + category.id, body, 'user', 'DELETE')).status, 409);
  assert.equal(sql.prepare('SELECT count(*) n FROM budget_records WHERE id=?').get(category.id).n, 1);
  assert.equal((await call('/records/' + category.id, body, 'alfred', 'DELETE')).status, 403);
  assert.equal((await call('/proposals', { resource: 'category', action: 'delete', id: category.id, version: archived.version, fields: {}, reason: 'Not permitted' }, 'alfred')).status, 400);
  await call('/proposals/' + proposal.proposal_id + '/reject', {});
  assert.equal((await call('/records/' + category.id, body, 'user', 'DELETE')).status, 200);
});

test('delete guards concurrent reference creation and rolls back if its audit cannot be saved', async t => {
  const { call, create, update, env, sql } = setup(t);
  const category = (await create('category', { name: 'Concurrent reference' })).record;
  const archived = (await update(category, 'archive')).record;
  const batch = env.DB.batch;
  env.DB.batch = async statements => {
    env.DB.batch = batch;
    sql.prepare('INSERT INTO budget_records(id,kind,data,updated_at) VALUES(?,?,?,?)').run('late-limit', 'limit', JSON.stringify({ category_id: category.id, period: 'monthly', amount: 100, start_date: '2026-11-01' }), '2026-11-11');
    return batch(statements);
  };
  const body = { version: archived.version, confirm: true, request_id: 'delete-concurrent-test' };
  assert.equal((await call('/records/' + category.id, body, 'user', 'DELETE')).status, 409);
  assert.equal(sql.prepare('SELECT count(*) n FROM budget_records WHERE id=?').get(category.id).n, 1);
  sql.exec("DELETE FROM budget_records WHERE id='late-limit'; CREATE TRIGGER reject_deletion_audit BEFORE INSERT ON budget_changes WHEN NEW.action='delete' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  t.mock.method(console, 'error', () => {});
  assert.equal((await call('/records/' + category.id, body, 'user', 'DELETE')).status, 500);
  assert.equal(sql.prepare('SELECT count(*) n FROM budget_records WHERE id=?').get(category.id).n, 1);
});

test('a prepared write cannot create a dangling reference after its category is deleted', async t => {
  const { create, env, sql } = setup(t);
  const category = (await create('category', { name: 'Race category' })).record;
  const batch = env.DB.batch;
  env.DB.batch = async statements => {
    env.DB.batch = batch;
    sql.prepare('DELETE FROM budget_records WHERE id=?').run(category.id);
    return batch(statements);
  };
  assert.equal((await create('transaction', expense({ category_id: category.id }))).status, 409);
  assert.equal(sql.prepare("SELECT count(*) n FROM budget_records WHERE kind='transaction'").get().n, 0);
});
