import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/budget-subscriptions-preview.js';

const preview = globalThis.budgetSubscriptionPreview;

test('scheduled renewals stay separate from confirmed period spending', () => {
  const month = preview.totals(preview.subscriptions, '2026-11-01', '2026-11-30');
  assert.equal(month.paid, 4000);
  assert.equal(month.upcoming, 7200);
  assert.equal(month.monthly, 5700);
  assert.equal(month.active, 5);
  const week = preview.totals(preview.subscriptions, '2026-11-09', '2026-11-15');
  assert.equal(week.paid, 1200);
  assert.equal(week.upcoming, 0);
});

test('pausing tracking retains historical spending and excludes future renewal costs', () => {
  const paused = preview.subscriptions.map(s => ({ ...s, active: false }));
  const month = preview.totals(paused, '2026-11-01', '2026-11-30');
  assert.equal(month.paid, 4000);
  assert.equal(month.upcoming, 0);
  assert.equal(month.monthly, 0);
  assert.equal(month.active, 0);
});

test('renewals clamp short months without losing the original billing day', () => {
  assert.equal(preview.nextDate('2027-01-31', 'monthly', 31), '2027-02-28');
  assert.equal(preview.nextDate('2027-02-28', 'monthly', 31), '2027-03-31');
  assert.equal(preview.nextDate('2028-02-29', 'yearly', 29), '2029-02-28');
  assert.equal(preview.nextDate('2027-12-20', 'yearly', 20), '2028-12-20');
});

test('calendar separates paid charges from future monthly and yearly renewals', () => {
  const november = preview.calendarEvents(preview.subscriptions, 2026, 11);
  assert.deepEqual(november.map(e => e.date), ['2026-11-01', '2026-11-05', '2026-11-10', '2026-11-18', '2026-11-24']);
  assert.equal(november.filter(e => e.status === 'paid').reduce((sum, e) => sum + e.amount, 0), 4000);
  assert.equal(november.filter(e => e.status === 'scheduled').reduce((sum, e) => sum + e.amount, 0), 7200);
  const december = preview.calendarEvents(preview.subscriptions, 2026, 12);
  assert.equal(december.length, 4);
  assert.equal(december.reduce((sum, e) => sum + e.amount, 0), 5200);
  assert.ok(november.some(e => e.name === 'Password manager' && e.date === '2026-11-24'));
  assert.ok(!december.some(e => e.name === 'Password manager'));
  assert.equal(preview.calendarEvents(preview.subscriptions, 2027, 11).find(e => e.name === 'Password manager').date, '2027-11-24');
  assert.equal(preview.nextDate('2026-11-24', 'yearly', 24), '2027-11-24');
  assert.equal(preview.calendarEvents(preview.subscriptions, 2027, 1).length, 4);
});

test('calendar retains history for paused plans and clamps future billing days', () => {
  const paused = preview.subscriptions.map(s => ({ ...s, active: false }));
  assert.equal(preview.calendarEvents(paused, 2026, 11).length, 3);
  assert.equal(preview.calendarEvents(paused, 2026, 12).length, 0);
  const monthEnd = [{ id: 1, name: 'Month end', active: true, amount: 1000, cycle: 'monthly', next: '2027-01-31', billingDay: 31, payments: [] }];
  assert.equal(preview.calendarEvents(monthEnd, 2027, 2)[0].date, '2027-02-28');
  assert.equal(preview.calendarEvents(monthEnd, 2027, 3)[0].date, '2027-03-31');
  assert.equal(preview.calendarEvents(monthEnd, 2026, 12).length, 0);
});

test('a confirmed billing cycle never also appears as a scheduled charge', () => {
  const list = [{ id: 1, name: 'Music', active: true, amount: 1200, cycle: 'monthly', next: '2026-11-18', billingDay: 18, payments: [{ date: '2026-11-11', cycleDate: '2026-11-18', amount: 1200 }] }];
  assert.equal(preview.calendarEvents(list, 2026, 11).length, 1);
  assert.equal(preview.calendarEvents(list, 2026, 11)[0].status, 'paid');
});
