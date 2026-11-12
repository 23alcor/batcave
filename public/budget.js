import { budgetPeriod, personalSpending, shareRemaining, subscriptionCalendar, summarizeBudget, parseBudgetMoney } from './budget-core.js';
import { parseBudgetCSV, budgetImportRows } from './budget-csv.js';

const ui = { period: 'monthly', filter: 'all', search: '', month: '', day: '', calendar: true };
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const dollars = cents => (cents / 100).toFixed(2);
const monthEnd = start => budgetPeriod(start).end;
const monthShift = (start, delta) => new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1 + delta, 1)).toISOString().slice(0, 10);
const dateLabel = date => new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const newId = () => crypto.randomUUID();

export async function renderBudgetApp(view, { api, esc, toast }) {
  let snapshot, busy = false, selected = null;
  const route = location.hash.split('/')[2] || 'overview';
  const currentHash = location.hash;
  if (!view.hasChildNodes()) view.innerHTML = '<p class="muted" role="status">Loading your budget…</p>';
  const root = document.createElement('section'); root.className = 'budget-app';
  const all = kind => snapshot.records.filter(r => r.kind === kind);
  const active = kind => all(kind).filter(r => !r.archived);
  const find = id => snapshot.records.find(r => r.id === id);
  const categoryName = id => find(id)?.data.name || 'Uncategorized';
  const button = (label, action, id = '', extra = '') => `<button type="button" data-b="${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const empty = text => `<div class="b-empty">${text}</div>`;
  const catOptions = chosen => '<option value="">Choose category</option>' + active('category').map(c => `<option value="${esc(c.id)}" ${c.id === chosen ? 'selected' : ''}>${esc(c.data.name)}</option>`).join('');
  const field = (label, name, value = '', type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const catField = id => `<label>Category<select name="category_id" required>${catOptions(id)}</select></label>`;
  const amountField = value => field('Amount ($)', 'amount', value == null ? '' : dollars(value), 'number', 'required min="0.01" max="1000000" step="0.01"');
  const periodControls = () => `<div class="b-toggle" aria-label="Budget period">${['monthly', 'weekly'].map(p => button(p === 'monthly' ? 'Monthly' : 'Weekly', 'period', p, `aria-pressed="${ui.period === p}"`)).join('')}</div>`;
  const save = async change => api('/api/budget/changes', { method: 'POST', body: { ...change, request_id: change.request_id || newId() } });
  async function reload() {
    snapshot = await api('/api/budget');
    if (location.hash !== currentHash || !view.isConnected) return;
    if (!ui.month) ui.month = snapshot.today.slice(0, 7) + '-01';
    draw();
  }
  async function perform(fn, message = 'Saved') {
    if (busy) return;
    busy = true; root.inert = true;
    try { await fn(); toast(message); await reload(); } catch (error) { toast(error.message); }
    finally { busy = false; root.inert = false; }
  }
  function dialog(title, body, submit, label = 'Save') {
    root.querySelector('dialog')?.remove();
    const el = document.createElement('dialog');
    el.innerHTML = `<form><h2>${esc(title)}</h2><div class="b-form-grid">${body}</div><p class="b-error" role="alert"></p><div class="b-dialog-actions">${button('Cancel', 'cancel')}<button type="submit">${esc(label)}</button></div></form>`;
    root.append(el); el.querySelector('[data-b="cancel"]').onclick = () => el.close();
    el.addEventListener('close', () => el.remove());
    const request_id = newId();
    el.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const submitButton = el.querySelector('[type="submit"]'); submitButton.disabled = true;
      try { const refresh = await submit(Object.fromEntries(new FormData(event.target)), request_id); el.close(); if (refresh !== false) { toast('Saved'); await reload(); } }
      catch (error) { el.querySelector('.b-error').textContent = error.message; submitButton.disabled = false; }
    };
    el.showModal();
  }
  function changeFor(record, action, fields = {}) { return { resource: record.kind, action, id: record.id, version: record.version, fields }; }
  function transactionForm(record = null, subscriptionEvent = null) {
    const sub = subscriptionEvent && find(subscriptionEvent.subscription_id);
    const d = record?.data || { name: sub?.data.name || '', amount: sub?.data.amount, date: subscriptionEvent?.date <= snapshot.today ? subscriptionEvent.date : snapshot.today, category_id: sub?.data.category_id, status: 'tracked', shares: [] };
    const locked = !!d.external_id;
    dialog(record ? 'Edit transaction' : sub ? 'Record confirmed subscription charge' : 'Add expense', `${field('Description', 'name', d.name, 'text', 'required maxlength="120"')}${amountField(d.amount)}${field('Charge date', 'date', d.date, 'date', `required max="${snapshot.today}" ${locked ? 'readonly' : ''}`)}${catField(d.category_id)}<label>Status<select name="status">${['review', 'tracked', 'ignored'].map(s => `<option value="${s}" ${d.status === s ? 'selected' : ''}>${s === 'review' ? 'Needs review' : s}</option>`).join('')}</select></label><label class="b-full">Friends’ shares (one per line: Name | dollars)<textarea name="shares" rows="3" ${d.settlements?.length ? 'readonly' : ''}>${esc((d.shares || []).map(s => `${s.name} | ${dollars(s.amount)}`).join('\n'))}</textarea></label><p class="b-note b-full">Your spending is the charge minus friends’ shares. Repayments reduce what’s owed; forgiven amounts become your spending.${locked ? ' Imported charge amount and date cannot be rewritten.' : ''}${sub ? ' Record this only after the charge is confirmed. Schedules do not count as spending.' : ''}</p>`, async (values, request_id) => {
      const shares = values.shares.split('\n').filter(s => s.trim()).map((line, i) => {
        const parts = line.split('|'); if (parts.length !== 2) throw new Error('Use Name | dollars for each person.');
        return { ...(d.shares?.[i]?.id ? { id: d.shares[i].id } : {}), name: parts[0].trim(), amount: parseBudgetMoney(parts[1].trim()) };
      });
      const fields = { name: values.name, amount: parseBudgetMoney(values.amount), date: values.date, category_id: values.category_id || null, status: values.status, shares };
      if (sub) Object.assign(fields, { subscription_id: sub.id, billing_date: subscriptionEvent.date });
      await save({ ...(record ? changeFor(record, 'update', fields) : { resource: 'transaction', action: 'create', fields }), request_id });
    });
    if (locked) root.querySelector('dialog [name="amount"]').readOnly = true;
  }
  function subscriptionForm(record = null) {
    const d = record?.data || { name: '', amount: null, cycle: 'monthly', start_date: snapshot.today, category_id: active('category').find(c => /subscription/i.test(c.data.name))?.id, method: '', active: true };
    dialog(record ? 'Edit subscription' : 'Add subscription', `${field('Subscription', 'name', d.name, 'text', 'required maxlength="120"')}${amountField(d.amount)}<label>Billing cycle<select name="cycle"><option value="monthly" ${d.cycle === 'monthly' ? 'selected' : ''}>Monthly</option><option value="yearly" ${d.cycle === 'yearly' ? 'selected' : ''}>Annual</option></select></label>${field('First billing date', 'start_date', d.start_date, 'date', 'required')}${field('Billing day (1–31)', 'billing_day', d.billing_day || Number(d.start_date.slice(-2)), 'number', 'required min="1" max="31"')}${catField(d.category_id)}${field('Payment method', 'method', d.method, 'text', 'maxlength="60" placeholder="e.g. Visa •1234"')}<label>Status<select name="active"><option value="true" ${d.active ? 'selected' : ''}>Active</option><option value="false" ${!d.active ? 'selected' : ''}>Paused</option></select></label><p class="b-note b-full">Annual subscriptions appear in their renewal month. Only confirmed charges count toward your budget. Short months use their last day.</p>`, async (v, request_id) => {
      const fields = { ...v, amount: parseBudgetMoney(v.amount), billing_day: Number(v.billing_day), active: v.active === 'true' };
      await save({ ...(record ? changeFor(record, 'update', fields) : { resource: 'subscription', action: 'create', fields }), request_id });
    });
  }
  function limitForm(category) {
    const start_date = budgetPeriod(snapshot.today, ui.period).start;
    const record = active('limit').find(r => r.data.category_id === category.id && r.data.period === ui.period && r.data.start_date === start_date);
    dialog(`${category.data.name} · ${ui.period} limit`, `${field('Budget limit ($)', 'amount', dollars(summarizeBudget(snapshot.records, snapshot.today, ui.period).categories.find(c => c.id === category.id)?.budget ?? 0), 'number', 'required min="0" max="1000000" step="0.01"')}<p class="b-note b-full">Applies to ${esc(start_date)} through ${esc(budgetPeriod(snapshot.today, ui.period).end)}. Weekly and monthly amounts are linked using 52 weeks per year (about 4.33 weeks per month). Saving either updates both views; the most recently saved applicable limit is used. Carries forward until you change it in a later period. Past periods stay unchanged.</p>`, async (v, request_id) => {
      const fields = { category_id: category.id, period: ui.period, start_date, amount: parseBudgetMoney(v.amount) };
      await save({ ...(record ? changeFor(record, 'update', fields) : { resource: 'limit', action: 'create', fields }), request_id });
    });
  }
  function categoryForm(record = null) {
    dialog(record ? 'Edit category' : 'Add category', `${field('Category', 'name', record?.data.name || '', 'text', 'required maxlength="60"')}${field('Chart color', 'color', record?.data.color || '#006c67', 'color')}`, async (fields, request_id) => save({ ...(record ? changeFor(record, 'update', fields) : { resource: 'category', action: 'create', fields }), request_id }));
  }
  function archive(record) {
    const action = record.archived ? 'restore' : 'archive';
    dialog(`${action === 'archive' ? 'Archive' : 'Restore'} ${record.data.name || 'limit'}?`, `<p class="b-full">${action === 'archive' ? 'This one record will be excluded from active totals. Its data and history stay available, and you can restore it.' : 'This record will return to active totals.'}</p>`, async (_, request_id) => save({ ...changeFor(record, action), request_id }), action === 'archive' ? 'Archive record' : 'Restore record');
  }
  function settlement(record, share, kind) {
    const remaining = shareRemaining(record.data, share.id);
    dialog(`${kind === 'repay' ? 'Record repayment from' : 'Forgive debt for'} ${share.name}`, `${amountField(remaining)}${field('Date', 'date', snapshot.today, 'date', `required max="${snapshot.today}"`)}${kind === 'repay' ? field('Method', 'method', 'Zelle', 'text', 'required maxlength="40"') : '<p class="b-note b-full">Forgiven amounts become your spending in the outing’s category and original budget period.</p>'}`, async (v, request_id) => save({ ...changeFor(record, kind, { share_id: share.id, amount: parseBudgetMoney(v.amount), date: v.date, ...(kind === 'repay' ? { method: v.method } : {}) }), request_id }), kind === 'repay' ? 'Record repayment' : 'Forgive amount');
  }
  function details(record) {
    selected = record;
    const d = record.data;
    dialog(d.name, `<div class="b-full"><div class="b-details-grid"><div><p>Full charge</p><strong class="b-money-big">${money(d.amount)}</strong></div><div><p>Your spending</p><strong class="b-money-big">${money(personalSpending(d))}</strong></div></div><p>${esc(d.date)} · ${esc(categoryName(d.category_id))} · ${esc(d.status)}</p>${(d.shares || []).map(s => { const balance = shareRemaining(d, s.id); const forgiven = d.settlements.filter(p => p.share_id === s.id && p.kind === 'forgive').reduce((n, p) => n + p.amount, 0); return `<div class="b-line"><div><strong>${esc(s.name)}</strong><p>${money(balance)} unpaid · ${money(forgiven)} forgiven</p></div><div class="b-row-actions">${balance && !record.archived ? button('Paid me', 'repay', s.id) + button('Forgive', 'forgive', s.id) : esc(forgiven ? 'Settled (includes forgiveness)' : 'Paid in full')}</div></div>`; }).join('')}${!record.archived ? button('Archive transaction', 'archive', record.id) : button('Restore transaction', 'archive', record.id)}<h3>Payment history</h3>${d.settlements.length ? d.settlements.map(p => `<p>${esc(d.shares.find(s => s.id === p.share_id)?.name)} · ${money(p.amount)} · ${esc(p.kind === 'repay' ? p.method : 'Forgiven')} · ${esc(p.date)}</p>`).join('') : '<p>No repayments recorded.</p>'}</div>`, async () => {}, 'Done');
    root.querySelector('dialog form').onsubmit = e => { e.preventDefault(); root.querySelector('dialog').close(); };
  }
  function trend(summary) {
    const points = ui.period === 'weekly' ? summary.daily.map(d => ({ label: dateLabel(d.date), spent: d.amount, budget: summary.budget ? summary.budget / 7 : null })) : Array.from({ length: 7 }, (_, i) => {
      const date = monthShift(snapshot.today.slice(0, 7) + '-01', i - 6); const s = summarizeBudget(snapshot.records, i === 6 ? snapshot.today : monthEnd(date), 'monthly');
      return { label: new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), spent: s.spent, budget: s.budget || null };
    });
    const max = Math.max(100, ...points.flatMap(p => [p.spent || 0, p.budget || 0])) * 1.15;
    const x = i => 70 + i * 90, y = n => 245 - n / max * 200;
    const lines = key => points.map((p, i) => p[key] == null ? '' : `${i && points[i - 1][key] != null ? 'L' : 'M'}${x(i)},${y(p[key])}`).join(' ');
    return `<div class="b-chart-frame"><svg class="b-chart" viewBox="0 0 650 290" role="img" aria-label="Spending compared with saved budget limits">${[0, .5, 1].map(f => `<line class="b-gridline" x1="65" x2="620" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="3" y="${y(max * f) + 4}">${esc(money(Math.round(max * f)))}</text>`).join('')}<path class="b-limit" d="${lines('budget')}"/>${points.map((p, i) => p.budget == null ? '' : `<circle cx="${x(i)}" cy="${y(p.budget)}" r="3" class="b-limit-dot"/>`).join('')}<path class="b-spend" d="${lines('spent')}"/>${points.map((p, i) => `<text text-anchor="middle" x="${x(i)}" y="275">${esc(p.label)}</text>`).join('')}</svg></div>`;
  }
  function overview() {
    const s = summarizeBudget(snapshot.records, snapshot.today, ui.period), period = ui.period === 'monthly' ? 'month' : 'week';
    const pace = !s.budget ? 'Set limits first' : s.pace > 0 ? `${money(s.pace)} ahead` : `${money(-s.pace)} below`;
    const stats = [['Budget remaining', money(s.remaining), s.budget ? `${money(s.budget)} across your categories` : 'Set category limits to build your budget'], [`Spent this ${period}`, money(s.spent), 'Confirmed personal spending'], ['Spending pace', pace, 'Compared with an even daily budget'], ['Transactions to review', s.review_count, `${money(s.review_amount)} awaiting your decision`]];
    let offset = 0; const total = Math.max(s.budget, s.spent, 1);
    const slices = s.categories.filter(c => c.spent > 0).map(c => { const from = offset; offset += c.spent / total * 100; return `${c.data.color} ${from}% ${offset}%`; });
    if (offset < 100) slices.push(`var(--b-remainder) ${offset}% 100%`);
    const events = subscriptionCalendar(all('subscription'), all('transaction'), snapshot.today.slice(0, 7) + '-01', monthEnd(snapshot.today));
    const paid = events.filter(e => e.status === 'paid').reduce((n, e) => n + e.amount, 0), scheduled = events.filter(e => e.status === 'scheduled').reduce((n, e) => n + e.amount, 0);
    return `<div class="b-stats">${stats.map(([label, value, note]) => `<article class="b-stat"><p class="b-stat-label">${label}</p><strong class="b-stat-value">${value}</strong><p class="b-stat-note">${note}</p></article>`).join('')}</div><div class="b-columns"><div><article class="b-panel"><div class="b-panel-head"><div><h2>Spending Trend</h2><p>${ui.period === 'monthly' ? 'Monthly spending vs saved budgets' : 'Daily spending vs an even weekly budget'}</p></div><div class="b-legend"><span><i class="b-dot"></i>Spent</span><span><i class="b-dot" style="background:var(--b-comparison)"></i>Budget</span></div></div>${trend(s)}<p class="b-note">${ui.period === 'monthly' ? 'Current month is month to date. Missing budget limits have no comparison line.' : 'Days after today have no spending bar.'}</p><h3>This week</h3><div class="b-week">${s.daily.map((d, i) => `<div class="b-week-day"><div class="b-week-value">${d.amount == null ? '—' : money(d.amount)}</div><div class="b-week-plot"><div class="b-week-bar" style="height:${d.amount ? Math.max(3, d.amount / Math.max(1, ...s.daily.map(v => v.amount || 0)) * 100) : 0}%"></div></div><div class="b-week-label">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]}</div></div>`).join('')}</div></article><article class="b-panel white"><div class="b-panel-head"><h2>Recent transactions</h2><a href="#/spending/transactions">View all</a></div>${transactionTable(active('transaction').sort((a, b) => b.data.date.localeCompare(a.data.date)).slice(0, 5))}</article></div><div><article class="b-panel"><div class="b-panel-head"><div><h2>${ui.period === 'monthly' ? 'Monthly' : 'Weekly'} Budget</h2><p>${esc(dateLabel(s.start))}–${esc(dateLabel(s.end))} · ${money(s.budget)} budgeted</p></div></div><div class="b-ring" style="background:conic-gradient(${slices.join(',')})"><div><strong>${s.budget ? (s.spent / s.budget * 100).toFixed(1) + '%' : '—'}</strong><span>SPENT</span></div></div><div class="b-category-row b-note"><span>Category</span><span>Spent / Budgeted</span></div>${s.categories.filter(c => !c.archived || c.spent).map(c => `<div class="b-category-row"><span><i class="b-dot" style="background:${c.data.color}"></i>${esc(c.data.name)}</span><span>${money(c.spent)} / ${money(c.budget)}</span></div>`).join('')}<div class="b-category-row b-rule"><strong>Remaining</strong><strong>${money(s.remaining)}</strong></div><a href="#/spending/categories">Edit category limits</a></article><article class="b-panel white"><div class="b-panel-head"><h2>Subscriptions</h2><a href="#/spending/subscriptions">View calendar</a></div><p>${money(paid)} confirmed · ${money(scheduled)} scheduled this month</p>${events.filter(e => e.status === 'scheduled').slice(0, 4).map(e => `<div class="b-line"><span>${esc(e.name)}<small>${esc(dateLabel(e.date))} · ${e.cycle === 'yearly' ? 'Annual' : 'Monthly'}</small></span><strong>${money(e.amount)}</strong></div>`).join('') || '<p>No scheduled subscriptions this month.</p>'}<p class="b-note">Schedules do not count as spending until a charge is confirmed.</p></article></div></div>`;
  }
  function transactionTable(rows) {
    return rows.length ? `<div class="b-table-wrap"><table><thead><tr><th>Transaction</th><th>Category</th><th>Status</th><th>Charge</th><th>Your spend</th><th></th></tr></thead><tbody>${rows.map(r => `<tr><td data-label="Transaction"><strong>${esc(r.data.name)}</strong><small>${esc(r.data.date)} · ${esc(r.data.source)}${r.archived ? ' · Archived' : ''}</small></td><td data-label="Category">${esc(categoryName(r.data.category_id))}</td><td data-label="Status"><span class="b-status ${r.data.status === 'review' ? 'review' : ''}">${esc(r.data.status === 'review' ? 'Needs review' : r.data.status)}</span></td><td class="b-num" data-label="Charge">${money(r.data.amount)}</td><td class="b-num" data-label="Your spend">${money(personalSpending(r.data))}</td><td><div class="b-row-actions">${button('Details', 'detail', r.id)}${!r.archived ? button('Edit', 'edit-transaction', r.id) + (r.data.status === 'review' ? button('Track', 'track', r.id) + button('Ignore', 'ignore', r.id) : '') : button('Restore', 'archive', r.id)}</div></td></tr>`).join('')}</tbody></table></div>` : empty('No transactions here yet. Add an expense or import a statement.');
  }
  function transactions() {
    const rows = all('transaction').filter(r => !r.archived && (ui.filter === 'all' || r.data.status === ui.filter) && `${r.data.name} ${categoryName(r.data.category_id)}`.toLowerCase().includes(ui.search.toLowerCase())).sort((a, b) => b.data.date.localeCompare(a.data.date));
    return `<article class="b-panel white"><div class="b-panel-head"><h2>Transactions</h2><div class="b-actions">${button('Add expense', 'add-transaction')}${button('Import CSV', 'import')}</div></div><div class="b-filters"><div class="b-tabs">${[['all', 'All'], ['review', 'Needs review'], ['tracked', 'Tracked'], ['ignored', 'Ignored']].map(([id, label]) => button(label, 'filter', id, `aria-pressed="${ui.filter === id}"`)).join('')}</div><label>Search<input data-b-search value="${esc(ui.search)}" type="search" placeholder="Name or category"></label></div>${transactionTable(rows)}<p class="b-note">Review charges before tracking them. Friends’ shares are excluded from personal spending; repayments do not count as income. Live bank linking needs provider setup.</p></article>`;
  }
  function categories() {
    const s = summarizeBudget(snapshot.records, snapshot.today, ui.period);
    return `<article class="b-panel white"><div class="b-panel-head"><div><h2>Category limits</h2><p>${esc(s.start)}–${esc(s.end)} · ${money(s.budget)} total budget</p></div>${button('Add category', 'add-category')}</div><p class="b-note">Set ${ui.period} limits for this period. Weekly and monthly amounts are linked using about 4.33 weeks per month. Limits carry forward until changed; earlier periods keep their saved limits.</p>${s.categories.map(c => `<div class="b-setting-row"><div><strong><i class="b-dot" style="background:${c.data.color}"></i>${esc(c.data.name)}${c.archived ? ' (archived)' : ''}</strong><p>${money(c.spent)} spent / ${money(c.budget)} budgeted</p></div><div class="b-row-actions">${!c.archived ? button('Set limit', 'limit', c.id) + button('Edit', 'edit-category', c.id) : ''}${button(c.archived ? 'Restore' : 'Archive', 'archive', c.id)}</div></div>`).join('')}</article>`;
  }
  function eventDetails(events) {
    return events.length ? events.map((e, i) => `<div class="b-line"><div><strong>${esc(e.name)}</strong><small>${esc(e.date)} · ${e.cycle === 'yearly' ? 'Annual' : 'Monthly'} · ${e.status === 'paid' ? 'Confirmed' : 'Scheduled'}</small><p>${money(e.amount)}</p></div><div class="b-row-actions">${button('Edit', 'edit-subscription', e.subscription_id)}${e.status === 'paid' ? button('View charge', 'detail', e.transaction_id) : e.date <= snapshot.today ? button('Record charge', 'record-payment', `${e.subscription_id}|${e.date}`) : ''}</div></div>`).join('') : '<p>No subscriptions on this day.</p>';
  }
  function subscriptions() {
    const events = subscriptionCalendar(all('subscription'), all('transaction'), ui.month, monthEnd(ui.month));
    const offset = (new Date(ui.month + 'T12:00:00Z').getUTCDay() + 6) % 7;
    const days = Number(monthEnd(ui.month).slice(-2));
    const selectedEvents = events.filter(e => e.date === (ui.day || snapshot.today));
    const calendar = `<div class="b-cal-layout"><div><div class="b-cal-weekdays">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<span>${d}</span>`).join('')}</div><div class="b-cal-grid">${'<div class="b-cal-blank"></div>'.repeat(offset)}${Array.from({ length: days }, (_, i) => { const date = ui.month.slice(0, 7) + '-' + String(i + 1).padStart(2, '0'); return `<button type="button" class="b-cal-day" data-b="day" data-id="${date}" aria-pressed="${date === (ui.day || snapshot.today)}"><strong>${i + 1}</strong>${events.filter(e => e.date === date).map(e => `<span class="b-cal-event ${e.status}">${esc(e.name)} ${money(e.amount)}</span>`).join('')}</button>`; }).join('')}</div></div><aside><h3>${esc(ui.day || snapshot.today)}</h3>${eventDetails(selectedEvents)}</aside></div>`;
    return `<article class="b-panel white"><div class="b-panel-head"><div><h2>Subscription calendar</h2><p>Confirmed charges and scheduled renewals</p></div>${button('Add subscription', 'add-subscription')}</div><div class="b-panel-head"><div class="b-actions">${button('← Previous', 'month', '-1')}<strong>${new Date(ui.month + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</strong>${button('Next →', 'month', '1')}</div><div class="b-tabs">${button('Calendar', 'calendar', 'true', `aria-pressed="${ui.calendar}"`)}${button('List', 'calendar', 'false', `aria-pressed="${!ui.calendar}"`)}</div></div>${ui.calendar ? calendar : eventDetails(events)}<p class="b-note">Scheduled dates are estimates, including past dates without a confirmed charge. Record actual charges once; annual charges count in their renewal month.</p></article><article class="b-panel white"><h2>Manage subscriptions</h2>${active('subscription').length ? active('subscription').map(r => `<div class="b-setting-row"><div><strong>${esc(r.data.name)}</strong><p>${money(r.data.amount)} / ${r.data.cycle === 'yearly' ? 'year' : 'month'} · ${esc(r.data.method || 'No payment method')} · ${r.archived ? 'Archived' : r.data.active ? 'Active' : 'Paused'}</p></div><div class="b-row-actions">${!r.archived ? button('Edit', 'edit-subscription', r.id) : ''}${button(r.archived ? 'Restore' : 'Archive', 'archive', r.id)}</div></div>`).join('') : empty('Add your first monthly or annual subscription.')}</article>`;
  }
  function preview(record) {
    if (!record) return '<p>New record</p>';
    const labels = { name: 'Name', color: 'Chart color', amount: 'Amount', category_id: 'Category', period: 'Budget period', start_date: 'Starts', billing_day: 'Billing day', cycle: 'Billing cycle', method: 'Payment method', active: 'Tracking active', status: 'Review status', date: 'Charge date', bank_status: 'Bank status', source: 'Source', billing_date: 'Billing cycle date', subscription_id: 'Subscription', archived: 'Archived', shares: 'Friends’ shares', settlements: 'Repayments and forgiveness' };
    const value = (key, v) => {
      if (key === 'amount') return money(v);
      if (key === 'category_id') return categoryName(v);
      if (key === 'subscription_id') return find(v)?.data.name || 'None';
      if (key === 'shares') return v.map(s => `${s.name}: ${money(s.amount)}`).join('; ') || 'None';
      if (key === 'settlements') return v.map(s => `${record.data.shares.find(p => p.id === s.share_id)?.name || 'Person'}: ${money(s.amount)} ${s.kind === 'forgive' ? 'forgiven' : 'repaid'} on ${s.date}`).join('; ') || 'None';
      if (key === 'cycle') return v === 'yearly' ? 'Annual' : 'Monthly';
      return typeof v === 'boolean' ? v ? 'Yes' : 'No' : v || 'None';
    };
    return `<dl>${Object.entries({ ...record.data, archived: record.archived }).filter(([key]) => key !== 'external_id').map(([key, v]) => `<dt>${esc(labels[key] || key)}</dt><dd>${esc(value(key, v))}</dd>`).join('')}</dl>`;
  }

  function proposals() {
    return `<article class="b-panel white"><h2>Alfred proposals</h2><p>Alfred cannot apply changes himself. Review each exact change before approving it. Alfred cannot permanently delete records or reset the budget.</p>${snapshot.proposals.length ? snapshot.proposals.map(p => `<section class="b-proposal"><div class="b-panel-head"><h3>${esc(p.change.action)} ${esc(p.change.resource)}</h3><span class="b-status">${esc(p.status)}</span></div><p class="b-proposal-reason">${esc(p.reason)}</p><div class="b-diff"><div><h4>Before</h4>${preview(p.before)}</div><div><h4>After</h4>${preview(p.after)}</div></div><p class="b-note">Expires ${esc(new Date(p.expires_at).toLocaleString())}</p>${p.status === 'pending' ? `<div class="b-actions">${button('Approve this change', 'approve', p.id)}${button('Reject', 'reject', p.id)}</div>` : ''}</section>`).join('') : empty('No proposals. Ask Alfred to prepare a budget change.')}</article>`;
  }
  function archivedRecords() {
    const rows = snapshot.records.filter(r => r.archived);
    const name = r => r.data.name || `${categoryName(r.data.category_id)} · ${r.data.period} limit`;
    return `<article class="b-panel white"><div class="b-panel-head"><h2>Archived records</h2><span>${rows.length} archived</span></div><p class="b-note">Archived items stay out of active lists and totals. Restore them here, or permanently delete one after confirmation.</p>${rows.length ? rows.map(r => `<div class="b-setting-row"><div><strong>${esc(name(r))}</strong><small>${esc(r.kind)}${r.data.amount != null ? ' · ' + money(r.data.amount) : ''}</small></div><div class="b-row-actions">${button('Restore', 'archive', r.id)}${button('Delete permanently', 'delete', r.id)}</div></div>`).join('') : empty('No archived records.')}</article>`;
  }
  function deleteArchived(record) {
    const name = record.data.name || `${categoryName(record.data.category_id)} · ${record.data.period} limit`;
    dialog(`Permanently delete ${name}?`, '<p class="b-full">This permanently removes the archived record and its proposals. It cannot be restored or undone. Change history is retained for audit. Items still referenced by other records or pending proposals cannot be deleted.</p>', async (_, request_id) => api('/api/budget/records/' + record.id, { method: 'DELETE', body: { version: record.version, request_id, confirm: true } }), 'Delete permanently');
  }
  function history() {
    return `<article class="b-panel white"><div class="b-panel-head"><h2>Change history</h2>${button('Export budget JSON', 'export')}</div><p class="b-note">Latest 100 changes. Undo is available only when this record has no newer changes. Export includes your current records and the displayed history.</p>${snapshot.history.length ? snapshot.history.map(h => `<div class="b-audit"><div><strong>${esc(h.action)} · ${h.after.deleted ? 'Permanently deleted ' + esc(h.after.kind) : esc(h.after.data.name || categoryName(h.after.data.category_id))}</strong><small>${esc(h.actor)} · ${esc(new Date(h.created_at).toLocaleString())}</small></div>${find(h.record_id)?.version === h.after_version ? button('Review undo', 'undo', h.id) : ''}</div>`).join('') : empty('No changes yet.')}</article>`;
  }
  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 250000) throw new Error('CSV must be under 250 KB.');
      const rows = await budgetImportRows(parseBudgetCSV(await file.text()), active('category'));
      if (rows.some(r => r.date > snapshot.today)) throw new Error('Remove future-dated expenses before importing.');
      dialog('Review CSV import', `<p class="b-full">Import ${rows.length} expenses (${money(rows.reduce((n, r) => n + r.amount, 0))}) into Needs review. Nothing is counted as spending until you track it. Matching import IDs will be skipped.</p><div class="b-full b-table-wrap"><table><thead><tr><th>Date</th><th>Name</th><th>Charge</th></tr></thead><tbody>${rows.slice(0, 10).map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.name)}</td><td>${money(r.amount)}</td></tr>`).join('')}</tbody></table>${rows.length > 10 ? '<p>Showing first 10 rows.</p>' : ''}</div><p class="b-note b-full">Import is saved one row at a time. If interrupted, re-import this same file to resume without duplicating saved rows. Across different statements, use a stable unique id column for reliable deduplication.</p>`, async () => {
        let imported = 0, skipped = 0;
        for (const fields of rows) {
          if (snapshot.records.some(r => r.data.external_id === fields.external_id)) { skipped++; continue; }
          try { await save({ resource: 'transaction', action: 'create', fields, request_id: fields.external_id.replace(':', '-') }); imported++; }
          catch (error) { snapshot = await api('/api/budget'); throw new Error(`${imported} imported, ${skipped} skipped. Stopped: ${error.message}`); }
        }
        toast(`${imported} imported, ${skipped} skipped`);
      }, 'Import for review');
    } catch (error) { toast(error.message); }
  }
  function draw() {
    const pending = snapshot.proposals.filter(p => p.status === 'pending').length;
    const pages = [['overview', 'Overview'], ['transactions', 'Transactions'], ['subscriptions', 'Subscriptions'], ['categories', 'Categories'], ['approvals', `Alfred proposals${pending ? ` (${pending})` : ''}`], ['archive', 'Archive'], ['history', 'History']];
    root.innerHTML = `<header class="b-head"><div><p class="b-note">BATCAVE / BUDGET</p><h1>${route === 'overview' ? 'Your budget at a glance' : pages.find(p => p[0] === route)?.[1] || 'Budget'}</h1></div><div class="b-actions">${['overview', 'categories'].includes(route) ? periodControls() : ''}${route === 'overview' ? button('Add expense', 'add-transaction') : ''}</div></header><nav class="b-nav" aria-label="Budget pages">${pages.map(([id, label]) => `<a href="#/spending${id === 'overview' ? '' : '/' + id}" ${route === id ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>${({ overview, transactions, subscriptions, categories, approvals: proposals, archive: archivedRecords, history }[route] || overview)()}`;
    if (!root.isConnected) view.replaceChildren(root);
    const search = root.querySelector('[data-b-search]');
    if (search) search.oninput = () => { ui.search = search.value; const position = search.selectionStart; draw(); const input = root.querySelector('[data-b-search]'); input.focus(); input.setSelectionRange(position, position); };
  }
  root.addEventListener('click', event => {
    const target = event.target.closest('[data-b]'); if (!target || target.disabled) return;
    const action = target.dataset.b, id = target.dataset.id, record = find(id);
    if (action === 'period') { ui.period = id; draw(); }
    else if (action === 'filter') { ui.filter = id; draw(); }
    else if (action === 'add-transaction') transactionForm();
    else if (action === 'edit-transaction') transactionForm(record);
    else if (action === 'detail') details(record);
    else if (action === 'add-subscription') subscriptionForm();
    else if (action === 'edit-subscription') subscriptionForm(record);
    else if (action === 'add-category') categoryForm();
    else if (action === 'edit-category') categoryForm(record);
    else if (action === 'limit') limitForm(record);
    else if (action === 'archive') archive(record);
    else if (action === 'delete' && record?.archived) deleteArchived(record);
    else if (action === 'repay' || action === 'forgive') { const r = selected; root.querySelector('dialog')?.close(); settlement(r, r.data.shares.find(s => s.id === id), action); }
    else if (action === 'ignore') perform(() => save(changeFor(record, 'update', { status: 'ignored' })));
    else if (action === 'track') { if (!record.data.category_id) transactionForm(record); else perform(() => save(changeFor(record, 'update', { status: 'tracked' }))); }
    else if (action === 'month') { ui.month = monthShift(ui.month, Number(id)); ui.day = ui.month; draw(); }
    else if (action === 'day') { ui.day = id; draw(); }
    else if (action === 'calendar') { ui.calendar = id === 'true'; draw(); }
    else if (action === 'record-payment') {
      const [subscription_id, date] = id.split('|'); transactionForm(null, { subscription_id, date });
    } else if (action === 'approve' || action === 'reject') perform(() => api(`/api/budget/proposals/${id}/${action}`, { method: 'POST', body: {} }), action === 'approve' ? 'Approved and saved' : 'Proposal rejected');
    else if (action === 'undo') {
      const h = snapshot.history.find(h => h.id === id);
      dialog('Review undo', `<p class="b-full">Undo only this record’s latest change.</p><div class="b-diff b-full"><div><h4>Current</h4>${preview(h.after)}</div><div><h4>Restore</h4>${h.before ? preview(h.before) : '<p>Archive this newly created record.</p>'}</div></div>`, async (_, request_id) => api(`/api/budget/history/${id}/undo`, { method: 'POST', body: { request_id } }), 'Undo this change');
    } else if (action === 'export') download(`batcave-budget-${snapshot.today}.json`, JSON.stringify(snapshot, null, 2), 'application/json');
    else if (action === 'import') dialog('Import CSV statement', `<p class="b-full">Use date,name,amount headers, with optional category and id. Dates use YYYY-MM-DD; amounts are positive expense dollars. Credits and refunds are not supported in this importer.</p><p class="b-full"><a data-b="template" href="#">Download template</a></p><label class="b-full">CSV file<input name="statement" type="file" accept=".csv,text/csv" required></label><p class="b-note b-full">Bank linking is not configured. CSV charges arrive in Needs review.</p>`, async v => { setTimeout(() => importFile(v.statement), 0); return false; }, 'Review CSV');
    else if (action === 'template') { event.preventDefault(); download('batcave-expenses.csv', 'date,name,amount,category,id\n', 'text/csv'); }
  });
  try { await reload(); } catch (error) { view.innerHTML = `<p role="alert">${esc(error.message)}</p>`; }
}
