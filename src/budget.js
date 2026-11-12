import { isBudgetDay, budgetPeriod, personalSpending, shareRemaining, subscriptionCalendar, summarizeBudget } from '../public/budget-core.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const id = () => crypto.randomUUID().replace(/-/g, '');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const kinds = ['category', 'limit', 'transaction', 'subscription'];
const actions = ['create', 'update', 'archive', 'restore', 'repay', 'forgive'];
const fields = {
  category: ['name', 'color'], limit: ['category_id', 'period', 'amount', 'start_date'],
  transaction: ['name', 'amount', 'date', 'category_id', 'status', 'source', 'bank_status', 'external_id', 'subscription_id', 'billing_date', 'shares'],
  subscription: ['name', 'amount', 'cycle', 'start_date', 'billing_day', 'category_id', 'method', 'active'],
};
const text = (value, name, max = 120, optional = false) => {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} must be text, 1–${max} characters.`);
  return value.trim();
};
const cents = (value, zero = false) => {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 100000000) fail('Amounts must be integer cents, no more than $1,000,000.');
  return value;
};
const day = (value, name = 'date') => { if (!isBudgetDay(value)) fail(`${name} must be a real YYYY-MM-DD date.`); return value; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, allowed) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unknown or unsupported fields.'); };
const decode = row => row ? { ...row, archived: !!row.archived, data: JSON.parse(row.data) } : null;
const saved = row => row ? { id: row.id, kind: row.kind, data: row.data, version: row.version, archived: !!row.archived, updated_at: row.updated_at } : null;
async function records(env) { return (await env.DB.prepare('SELECT * FROM budget_records ORDER BY updated_at, id').all()).results.map(decode); }
async function readBody(req) {
  let body;
  try { body = await req.json(); } catch { fail('Send a JSON object.'); }
  if (!object(body) || JSON.stringify(body).length > 24000) fail('Budget request is invalid or too large.');
  return body;
}
function reference(list, recordId, kind, name) {
  const record = list.find(r => r.id === recordId && r.kind === kind);
  if (!record) fail(`${name} was not found in your budget.`, 404);
  return record;
}
function validateData(kind, data, list, today, before) {
  if (kind === 'category') {
    data.name = text(data.name, 'Category name', 60);
    if (typeof data.color !== 'string' || !/^#[\da-f]{6}$/i.test(data.color)) fail('Use a six-digit hex color.');
  }
  if (kind === 'limit') {
    reference(list, data.category_id, 'category', 'Category');
    if (!['weekly', 'monthly'].includes(data.period)) fail('Budget period must be weekly or monthly.');
    day(data.start_date, 'Budget period start');
    if (budgetPeriod(data.start_date, data.period).start !== data.start_date) fail('Monthly budgets start on the first; weekly budgets start on Monday.');
    cents(data.amount, true);
  }
  if (kind === 'transaction' || kind === 'subscription') {
    data.name = text(data.name, 'Name'); cents(data.amount);
    if (data.category_id) reference(list, data.category_id, 'category', 'Category');
  }
  if (kind === 'subscription') {
    if (!data.category_id) fail('Choose a category for the subscription.');
    day(data.start_date, 'First billing date');
    if (!['monthly', 'yearly'].includes(data.cycle)) fail('Billing cycle must be monthly or yearly.');
    if (!Number.isInteger(data.billing_day) || data.billing_day < 1 || data.billing_day > 31) fail('Billing day must be 1–31.');
    if (typeof data.active !== 'boolean') fail('active must be true or false.');
    data.method = text(data.method, 'Payment method', 60, true);
  }
  if (kind === 'transaction') {
    day(data.date); if (data.date > today) fail('Spending cannot be recorded in the future. Use a recurring subscription for scheduled charges.');
    if (!['review', 'tracked', 'ignored'].includes(data.status)) fail('Status must be review, tracked, or ignored.');
    if (!['manual', 'csv'].includes(data.source)) fail('Source must be manual or csv.');
    if (!['pending', 'posted'].includes(data.bank_status)) fail('Bank status must be pending or posted.');
    if (data.status === 'tracked' && !data.category_id) fail('Choose a category before tracking this expense.');
    if (data.external_id !== null) data.external_id = text(data.external_id, 'Import id', 180);
    if (before && before.data.external_id && ['amount', 'date', 'source', 'external_id'].some(key => data[key] !== before.data[key])) fail('Imported charge amounts and identities cannot be rewritten. Correct its categorization or archive it instead.');
    if (!Array.isArray(data.shares) || data.shares.length > 30) fail('An outing can have at most 30 shares.');
    const shareIds = new Set();
    for (const share of data.shares) {
      exact(share, ['id', 'name', 'amount']);
      share.id = text(share.id, 'Share id', 80); share.name = text(share.name, 'Person name', 80); cents(share.amount);
      if (shareIds.has(share.id)) fail('Share ids must be unique.'); shareIds.add(share.id);
    }
    if (data.shares.reduce((sum, share) => sum + share.amount, 0) > data.amount) fail('Friends’ shares cannot exceed the full charge.');
    if (!Array.isArray(data.settlements) || data.settlements.length > 300) fail('Too many repayments for this transaction.');
    for (const settlement of data.settlements) {
      if (!shareIds.has(settlement.share_id) || !['repay', 'forgive'].includes(settlement.kind)) fail('Invalid repayment or forgiveness entry.');
      cents(settlement.amount); day(settlement.date);
      if (settlement.date > today) fail('Repayments cannot be dated in the future.');
    }
    for (const share of data.shares) if (shareRemaining(data, share.id) < 0) fail(`Repayments and forgiveness exceed ${share.name}’s share.`);
    if (data.settlements.length && data.status !== 'tracked') fail('An outing with repayments must stay tracked. Archive it if it should be excluded.');
    if (data.subscription_id) {
      const subscription = reference(list, data.subscription_id, 'subscription', 'Subscription');
      day(data.billing_date, 'Billing cycle date');
      const changedCycle = !before || before.data.subscription_id !== data.subscription_id || before.data.billing_date !== data.billing_date;
      const occurrence = subscriptionCalendar([{ ...subscription, archived: false, data: { ...subscription.data, active: true } }], [], data.billing_date, data.billing_date);
      if ((changedCycle && !occurrence.length) || data.shares.length) fail('Choose a valid subscription billing cycle without an outing split.');
      if ((changedCycle || data.category_id !== before.data.category_id) && data.category_id !== subscription.data.category_id) fail('Subscription payment must use its subscription’s category.');
    } else if (data.billing_date) fail('Billing cycle date requires a subscription.');
    if (!Number.isSafeInteger(personalSpending(data))) fail('Invalid personal spending amount.');
  }
  if (data.category_id) {
    const category = reference(list, data.category_id, 'category', 'Category');
    if (category.archived && before?.data.category_id !== data.category_id) fail('This category is archived. Restore it first.');
  }
  return data;
}
async function prepareChange(env, change, today) {
  exact(change, ['resource', 'action', 'id', 'version', 'fields', 'request_id']);
  if (!kinds.includes(change.resource) || !actions.includes(change.action)) fail('Unknown budget resource or action. Bulk operations and permanent deletion are not supported.');
  const list = await records(env);
  const create = change.action === 'create';
  if (create && (change.id != null || change.version != null)) fail('Create one new record without an id or version.');
  const before = create ? null : saved(reference(list, text(change.id, 'Record id', 100), change.resource, 'Record'));
  if (before && (!Number.isInteger(change.version) || change.version !== before.version)) fail('This record changed. Refresh and review the latest version.', 409);
  if (before?.archived && change.action !== 'restore') fail('This record is archived. Restore it before editing.', 409);
  const patch = change.fields || {};
  let data = structuredClone(before?.data || {}), archived = before?.archived || false;
  if (['archive', 'restore'].includes(change.action)) {
    exact(patch, []); archived = change.action === 'archive';
    if (before.archived === archived) fail('This record already has that archive state.', 409);
    if (archived && change.resource === 'category' && list.some(r => !r.archived && r.data.category_id === before.id)) fail('This category is still used by limits, transactions, or subscriptions. Reassign or archive those records first.');
  } else if (['repay', 'forgive'].includes(change.action)) {
    if (change.resource !== 'transaction' || !before || data.status !== 'tracked') fail('Repayments need a tracked outing.');
    exact(patch, ['share_id', 'amount', 'date', 'method']);
    if (!data.shares.some(s => s.id === patch.share_id)) fail('Choose an exact person’s share from this outing.');
    const amount = cents(patch.amount);
    if (amount > shareRemaining(data, patch.share_id)) fail('Amount exceeds the unpaid balance.');
    data.settlements.push({ id: id(), share_id: patch.share_id, kind: change.action, amount, date: day(patch.date), method: change.action === 'forgive' ? '' : text(patch.method, 'Repayment method', 40) });
  } else {
    exact(patch, fields[change.resource]);
    if (!Object.keys(patch).length) fail('Include the fields to change.');
    if (create) {
      if (change.resource === 'category') data = { color: '#006c67' };
      if (change.resource === 'limit') data = { start_date: budgetPeriod(today, patch.period).start };
      if (change.resource === 'transaction') data = { category_id: null, status: 'review', source: 'manual', bank_status: 'posted', external_id: null, subscription_id: null, billing_date: null, shares: [], settlements: [] };
      if (change.resource === 'subscription') data = { active: true, method: '' };
    }
    Object.assign(data, structuredClone(patch));
    if (change.resource === 'transaction' && 'shares' in patch) {
      if (!Array.isArray(patch.shares)) fail('shares must be a list.');
      data.shares = patch.shares.map(share => { exact(share, ['id', 'name', 'amount']); return { ...share, id: share.id || id() }; });
      if (before?.data.settlements.length && JSON.stringify(data.shares) !== JSON.stringify(before.data.shares)) fail('Shares with payment history cannot be replaced. Undo the relevant payment first.');
    }
    if (change.resource === 'subscription' && patch.start_date && !('billing_day' in patch)) data.billing_day = Number(day(patch.start_date, 'First billing date').slice(-2));
  }
  validateData(change.resource, data, list, today, before);
  return { change: { ...change, fields: patch }, before, after: { id: before?.id || id(), kind: change.resource, data, archived, version: (before?.version || 0) + 1, updated_at: new Date().toISOString() } };
}
async function commit(env, prepared, requestId, actor, request, proposalId = null) {
  const { before, after, change } = prepared;
  const statements = [before
    ? env.DB.prepare("UPDATE budget_records SET data=?1, version=?2, archived=?3, updated_at=?4 WHERE id=?5 AND version=?6 AND (?7 IS NULL OR EXISTS(SELECT 1 FROM budget_proposals WHERE id=?7 AND status='pending' AND expires_at>?8)) AND (?9 IS NULL OR EXISTS(SELECT 1 FROM budget_records WHERE id=?9 AND kind='category')) AND (?10 IS NULL OR EXISTS(SELECT 1 FROM budget_records WHERE id=?10 AND kind='subscription'))").bind(JSON.stringify(after.data), after.version, Number(after.archived), after.updated_at, after.id, before.version, proposalId, new Date().toISOString(), after.data.category_id || null, after.data.subscription_id || null)
    : env.DB.prepare("INSERT INTO budget_records(id,kind,data,version,archived,updated_at) SELECT ?1,?2,?3,?4,?5,?6 WHERE (?7 IS NULL OR EXISTS(SELECT 1 FROM budget_proposals WHERE id=?7 AND status='pending' AND expires_at>?8)) AND (?9 IS NULL OR EXISTS(SELECT 1 FROM budget_records WHERE id=?9 AND kind='category')) AND (?10 IS NULL OR EXISTS(SELECT 1 FROM budget_records WHERE id=?10 AND kind='subscription')) ON CONFLICT(id) DO NOTHING").bind(after.id, after.kind, JSON.stringify(after.data), after.version, Number(after.archived), after.updated_at, proposalId, new Date().toISOString(), after.data.category_id || null, after.data.subscription_id || null)];
  // The audit is written only if the immediately preceding compare-and-swap succeeded, in the same transaction.
  statements.push(env.DB.prepare('INSERT INTO budget_changes(id,record_id,actor,action,before_record,after_record,after_version,created_at,request) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE changes()=1').bind(requestId, after.id, actor, change.action, before ? JSON.stringify(before) : null, JSON.stringify(after), after.version, after.updated_at, request));
  if (proposalId) statements.push(env.DB.prepare("UPDATE budget_proposals SET status='approved' WHERE id=?1 AND status='pending' AND EXISTS(SELECT 1 FROM budget_changes WHERE id=?2)").bind(proposalId, requestId));
  const results = await env.DB.batch(statements);
  if (!results[0].meta?.changes) fail('Another edit won the race. Refresh and review the latest record.', 409);
  return { ok: true, record: after, change_id: requestId };
}
function requestId(body) { const value = body.request_id; if (typeof value !== 'string' || !/^[\w-]{8,100}$/.test(value)) fail('A unique request_id is required.'); return value; }
async function replay(env, requestId, request) {
  const row = await env.DB.prepare('SELECT * FROM budget_changes WHERE id=?1').bind(requestId).first();
  if (!row) return null;
  if (row.request !== request) fail('This request id was already used for a different change.', 409);
  return { ok: true, record: JSON.parse(row.after_record), change_id: row.id, replayed: true };
}
export async function budgetApi(req, env, path, today, actor = 'user') {
  try {
    const method = req.method;
    if (method === 'GET' && path === '/api/budget') {
      const list = await records(env);
      const proposals = (await env.DB.prepare('SELECT * FROM budget_proposals ORDER BY created_at DESC LIMIT 100').all()).results.map(p => ({ ...p, change: JSON.parse(p.change), before: p.before_record ? JSON.parse(p.before_record) : null, after: JSON.parse(p.after_record), status: p.status === 'pending' && p.expires_at < new Date().toISOString() ? 'expired' : p.status, before_record: undefined, after_record: undefined }));
      const history = (await env.DB.prepare('SELECT * FROM budget_changes ORDER BY created_at DESC, rowid DESC LIMIT 100').all()).results.map(c => ({ ...c, before: c.before_record ? JSON.parse(c.before_record) : null, after: JSON.parse(c.after_record), request: undefined, before_record: undefined, after_record: undefined }));
      return json({ today, records: list, proposals, history, monthly: summarizeBudget(list, today), weekly: summarizeBudget(list, today, 'weekly'), bank_connected: false });
    }
    if (actor !== 'user' && !(method === 'POST' && path === '/api/budget/proposals')) fail('Alfred can only prepare budget proposals. Approval and direct writes require the budget UI.', 403);
    const deletion = path.match(/^\/api\/budget\/records\/([\w-]+)$/);
    if (method === 'DELETE' && deletion) {
      const body = await readBody(req); exact(body, ['version', 'request_id', 'confirm']);
      if (body.confirm !== true) fail('Confirm permanent deletion of this archived record.');
      const key = requestId(body), request = JSON.stringify({ delete: deletion[1], ...body });
      const previous = await replay(env, key, request); if (previous) return json(previous);
      const list = await records(env), before = list.find(r => r.id === deletion[1]);
      if (!before) fail('Record was not found in your budget.', 404);
      if (!before.archived) fail('Archive this record before permanently deleting it.', 409);
      if (!Number.isInteger(body.version) || body.version !== before.version) fail('This record changed. Refresh and review the latest version.', 409);
      if (list.some(r => r.id !== before.id && (r.data.category_id === before.id || r.data.subscription_id === before.id))) fail('Other records still use this item, including archived records. Reassign or delete those first.', 409);
      const now = new Date().toISOString();
      const after = { id: before.id, kind: before.kind, data: {}, archived: true, deleted: true, version: before.version + 1, updated_at: now };
      // Guard references in the delete itself; the tombstone gates cleanup in the same transaction.
      const result = await env.DB.batch([
        env.DB.prepare("DELETE FROM budget_records WHERE id=?1 AND version=?2 AND archived=1 AND NOT EXISTS(SELECT 1 FROM budget_records r WHERE r.id<>?1 AND (json_extract(r.data,'$.category_id')=?1 OR json_extract(r.data,'$.subscription_id')=?1)) AND NOT EXISTS(SELECT 1 FROM budget_proposals WHERE status='pending' AND expires_at>?3 AND (json_extract(change,'$.fields.category_id')=?1 OR json_extract(change,'$.fields.subscription_id')=?1))").bind(before.id, before.version, now),
        env.DB.prepare("INSERT INTO budget_changes(id,record_id,actor,action,before_record,after_record,after_version,created_at,request) SELECT ?1,?2,'user','delete',NULL,?3,?4,?5,?6 WHERE changes()=1").bind(key, before.id, JSON.stringify(after), after.version, now, request),
        env.DB.prepare("DELETE FROM budget_proposals WHERE json_extract(change,'$.id')=?1 AND EXISTS(SELECT 1 FROM budget_changes WHERE id=?2)").bind(before.id, key),
      ]);
      if (!result[0].meta?.changes) fail('The record changed or is used by a pending proposal. Refresh and review its references.', 409);
      return json({ ok: true, record: after, change_id: key });
    }
    if (method === 'DELETE') fail('Delete one archived record from the Archive page. Bulk deletion is not supported.', 405);
    if (method === 'POST' && path === '/api/budget/changes') {
      const body = await readBody(req), key = requestId(body), request = JSON.stringify(body);
      const previous = await replay(env, key, request); if (previous) return json(previous);
      return json(await commit(env, await prepareChange(env, body, today), key, 'user', request));
    }
    if (method === 'POST' && path === '/api/budget/proposals') {
      const body = await readBody(req); exact(body, ['resource', 'action', 'id', 'version', 'fields', 'reason']);
      const reason = text(body.reason, 'Reason for the proposal', 500), { reason: ignored, ...change } = body;
      const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM budget_proposals WHERE status='pending' AND expires_at > ?1").bind(new Date().toISOString()).first('n');
      if (pending >= 20) fail('Review the existing budget proposals before adding more.', 409);
      const prepared = await prepareChange(env, change, today), key = id(), now = new Date().toISOString(), expires = new Date(Date.now() + 864e5).toISOString();
      await env.DB.prepare('INSERT INTO budget_proposals(id,change,before_record,after_record,reason,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(key, JSON.stringify(prepared.change), prepared.before ? JSON.stringify(prepared.before) : null, JSON.stringify(prepared.after), reason, now, expires).run();
      return json({ ok: true, proposal_id: key, status: 'pending', before: prepared.before, after: prepared.after, expires_at: expires, summary: 'Prepared for your review in Budget → Alfred proposals. Nothing in the budget has changed.' }, 201);
    }
    let match = path.match(/^\/api\/budget\/proposals\/([\w-]+)\/(approve|reject)$/);
    if (method === 'POST' && match) {
      const proposal = await env.DB.prepare('SELECT * FROM budget_proposals WHERE id=?1').bind(match[1]).first();
      if (!proposal) fail('Proposal not found.', 404);
      if (proposal.status === 'approved' && match[2] === 'approve') return json({ ok: true, already_approved: true });
      if (proposal.status !== 'pending') fail('This proposal was already reviewed.', 409);
      if (match[2] === 'reject') { await env.DB.prepare("UPDATE budget_proposals SET status='rejected' WHERE id=?1 AND status='pending'").bind(proposal.id).run(); return json({ ok: true }); }
      if (proposal.expires_at < new Date().toISOString()) fail('This proposal expired. Ask Alfred to prepare it again.', 409);
      const change = JSON.parse(proposal.change), before = proposal.before_record ? JSON.parse(proposal.before_record) : null;
      // Revalidate references and versions, but apply the exact stable IDs shown in the reviewed proposal.
      const checked = await prepareChange(env, change, today);
      if (JSON.stringify(checked.before) !== JSON.stringify(before)) fail('The record changed after this proposal. Review a fresh proposal.', 409);
      const after = JSON.parse(proposal.after_record); after.updated_at = new Date().toISOString();
      return json(await commit(env, { change, before, after }, 'proposal-' + proposal.id, 'alfred', JSON.stringify(change), proposal.id));
    }
    match = path.match(/^\/api\/budget\/history\/([\w-]+)\/undo$/);
    if (method === 'POST' && match) {
      const body = await readBody(req); exact(body, ['request_id']); const key = requestId(body), request = JSON.stringify({ undo: match[1], ...body });
      const previous = await replay(env, key, request); if (previous) return json(previous);
      const audit = await env.DB.prepare('SELECT * FROM budget_changes WHERE id=?1').bind(match[1]).first();
      if (!audit) fail('Change not found.', 404);
      if (audit.action === 'delete') fail('Permanent deletion cannot be undone.', 410);
      const list = await records(env), before = saved(reference(list, audit.record_id, JSON.parse(audit.after_record).kind, 'Record'));
      if (before.version !== audit.after_version) fail('There are newer edits to this record. Undo those first.', 409);
      const original = audit.before_record ? JSON.parse(audit.before_record) : null;
      if (!original && before.kind === 'category' && list.some(r => !r.archived && r.data.category_id === before.id)) fail('This category is now in use and cannot be archived by undo.');
      const after = { ...before, data: original?.data || before.data, archived: original ? original.archived : true, version: before.version + 1, updated_at: new Date().toISOString() };
      validateData(after.kind, after.data, list, today, before);
      return json(await commit(env, { before, after, change: { action: 'undo' } }, key, 'user', request));
    }
    return json({ error: 'Budget endpoint not found.' }, 404);
  } catch (error) {
    if (error.status) return json({ error: error.message }, error.status);
    if (/UNIQUE constraint/i.test(error.message)) return json({ error: 'That category, period limit, import, or subscription payment already exists. Refresh before retrying.' }, 409);
    console.error('budget', error.message);
    return json({ error: 'Budget could not be saved. Your data was not partially updated.' }, 500);
  }
}
