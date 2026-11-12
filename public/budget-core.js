// Shared calendar and accounting rules. Money is always integer cents.
export const isBudgetDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
export const budgetAddDays = (date, days) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export function budgetPeriod(today, period = 'monthly') {
  const date = new Date(today + 'T12:00:00Z');
  const start = period === 'weekly' ? budgetAddDays(today, -((date.getUTCDay() + 6) % 7)) : today.slice(0, 7) + '-01';
  const end = period === 'weekly' ? budgetAddDays(start, 6) : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
  return { start, end, days, elapsed: Math.max(1, Math.min(days, Math.round((Date.parse(today) - Date.parse(start)) / 864e5) + 1)) };
}
export const personalSpending = transaction => transaction.amount - (transaction.shares || []).reduce((sum, share) => sum + share.amount, 0) + (transaction.settlements || []).filter(s => s.kind === 'forgive').reduce((sum, s) => sum + s.amount, 0);
export const shareRemaining = (transaction, shareId) => (transaction.shares || []).find(s => s.id === shareId)?.amount - (transaction.settlements || []).filter(s => s.share_id === shareId).reduce((sum, s) => sum + s.amount, 0);
export function subscriptionCalendar(subscriptions, transactions, start, end) {
  const events = [];
  const activeTransactions = transactions.filter(t => !t.archived && t.data.status === 'tracked');
  for (const record of subscriptions) {
    const sub = record.data;
    for (const transaction of activeTransactions.filter(t => t.data.subscription_id === record.id && t.data.date >= start && t.data.date <= end)) events.push({ date: transaction.data.date, name: sub.name, amount: personalSpending(transaction.data), status: 'paid', subscription_id: record.id, transaction_id: transaction.id, cycle: sub.cycle });
    if (record.archived || !sub.active) continue;
    let month = start.slice(0, 7) + '-01';
    while (month <= end) {
      const year = Number(month.slice(0, 4)), index = Number(month.slice(5, 7)) - 1;
      const last = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
      const date = month.slice(0, 7) + '-' + String(Math.min(sub.billing_day, last)).padStart(2, '0');
      if (date >= sub.start_date && date >= start && date <= end && (sub.cycle === 'monthly' || date.slice(5, 7) === sub.start_date.slice(5, 7)) && !activeTransactions.some(t => t.data.subscription_id === record.id && t.data.billing_date === date)) events.push({ date, name: sub.name, amount: sub.amount, status: 'scheduled', subscription_id: record.id, cycle: sub.cycle });
      month = new Date(Date.UTC(year, index + 1, 1)).toISOString().slice(0, 10);
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}
export function summarizeBudget(records, today, period = 'monthly') {
  const window = budgetPeriod(today, period);
  const active = records.filter(r => !r.archived);
  const transactions = active.filter(r => r.kind === 'transaction');
  const tracked = transactions.filter(r => r.data.status === 'tracked' && r.data.date >= window.start && r.data.date <= window.end);
  const categories = active.filter(r => r.kind === 'category').map(record => {
    // Keep each cadence's latest effective limit, then use whichever was saved most recently.
    const candidates = ['monthly', 'weekly'].map(cadence => active.filter(r => r.kind === 'limit' && r.data.category_id === record.id && r.data.period === cadence && r.data.start_date <= budgetPeriod(today, cadence).start)
      .sort((a, b) => b.data.start_date.localeCompare(a.data.start_date))[0]).filter(Boolean);
    const limit = candidates.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || b.data.start_date.localeCompare(a.data.start_date))[0];
    const budget = !limit ? 0 : limit.data.period === period ? limit.data.amount
      : Math.round(limit.data.amount * (period === 'weekly' ? 12 / 52 : 52 / 12));
    return { ...record, spent: tracked.filter(t => t.data.category_id === record.id).reduce((sum, t) => sum + personalSpending(t.data), 0), budget };
  });
  const spent = tracked.reduce((sum, r) => sum + personalSpending(r.data), 0), budget = categories.reduce((sum, c) => sum + c.budget, 0);
  const review = transactions.filter(r => r.data.status === 'review');
  const expected = Math.round(budget * window.elapsed / window.days);
  const week = budgetPeriod(today, 'weekly');
  const daily = Array.from({ length: 7 }, (_, i) => { const date = budgetAddDays(week.start, i); return { date, amount: date > today ? null : transactions.filter(r => r.data.status === 'tracked' && r.data.date === date).reduce((sum, r) => sum + personalSpending(r.data), 0) }; });
  return { ...window, period, spent, budget, remaining: budget - spent, expected, pace: spent - expected, categories, review_count: review.length, review_amount: review.reduce((sum, r) => sum + r.data.amount, 0), daily };
}
export function parseBudgetMoney(value) {
  if (typeof value !== 'string' || !/^\d{1,7}(\.\d{1,2})?$/.test(value.trim())) throw new Error('Enter a positive dollar amount with at most two decimal places.');
  const [whole, fraction = ''] = value.trim().split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 100000000) throw new Error('Amount must be no more than $1,000,000.');
  return cents;
}
