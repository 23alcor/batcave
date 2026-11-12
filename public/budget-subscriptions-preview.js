globalThis.budgetSubscriptionPreview = {
  today: '2026-11-11',
  subscriptions: [
    { id: 1, name: 'Music', amount: 1200, cycle: 'monthly', next: '2026-11-18', billingDay: 18, method: 'Credit card', active: true, payments: [] },
    { id: 2, name: 'Cloud storage', amount: 300, cycle: 'monthly', next: '2026-12-01', billingDay: 1, method: 'Credit card', active: true, payments: [{ date: '2026-11-01', amount: 300 }] },
    { id: 3, name: 'Gym', amount: 2500, cycle: 'monthly', next: '2026-12-05', billingDay: 5, method: 'Checking', active: true, payments: [{ date: '2026-11-05', amount: 2500 }] },
    { id: 4, name: 'Design tools', amount: 1200, cycle: 'monthly', next: '2026-12-10', billingDay: 10, method: 'Credit card', active: true, payments: [{ date: '2026-11-10', amount: 1200 }] },
    { id: 5, name: 'Password manager', amount: 6000, cycle: 'yearly', next: '2026-11-24', billingDay: 24, method: 'Credit card', active: true, payments: [] }
  ],
  totals(list, start, end) {
    const active = list.filter(s => s.active);
    const due = active.filter(s => s.next >= start && s.next <= end).sort((a, b) => a.next.localeCompare(b.next));
    const paid = list.flatMap(s => s.payments).filter(p => p.date >= start && p.date <= end).reduce((sum, p) => sum + p.amount, 0);
    const upcoming = due.reduce((sum, s) => sum + s.amount, 0);
    const monthly = Math.round(active.reduce((sum, s) => sum + s.amount / (s.cycle === 'yearly' ? 12 : 1), 0));
    return { active: active.length, due, paid, upcoming, monthly };
  },
  calendarEvents(list, year, month) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const events = [];
    for (const subscription of list) {
      for (const payment of subscription.payments) {
        if (payment.date.startsWith(prefix + '-')) events.push({ subscriptionId: subscription.id, name: subscription.name, date: payment.date, amount: payment.amount, status: 'paid' });
      }
      if (!subscription.active) continue;
      const date = `${prefix}-${String(Math.min(subscription.billingDay, lastDay)).padStart(2, '0')}`;
      if (date < subscription.next || (subscription.cycle === 'yearly' && month !== Number(subscription.next.slice(5, 7)))) continue;
      if (subscription.payments.some(payment => payment.cycleDate === date || payment.date === date)) continue;
      events.push({ subscriptionId: subscription.id, name: subscription.name, date, amount: subscription.amount, status: 'scheduled' });
    }
    return events.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  },
  nextDate(date, cycle, billingDay) {
    const [year, month] = date.split('-').map(Number);
    const monthIndex = month - 1 + (cycle === 'yearly' ? 12 : 1);
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, monthIndex, Math.min(billingDay, lastDay))).toISOString().slice(0, 10);
  }
};
