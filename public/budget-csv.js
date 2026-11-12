import { isBudgetDay, parseBudgetMoney } from './budget-core.js';

// Statement amounts use positive expenses; credits/refunds need review outside this importer.
export function parseBudgetCSV(text) {
  if (typeof text !== 'string' || text.length > 250000) throw new Error('CSV must be under 250 KB.');
  const rows = []; let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || !field) quoted = !quoted;
      else throw new Error('Invalid CSV quote.');
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(field); field = '';
      if (c !== ',') { if (row.some(v => v.trim())) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else field += c;
  }
  if (quoted) throw new Error('CSV has an unclosed quote.');
  row.push(field); if (row.some(v => v.trim())) rows.push(row);
  const headers = (rows.shift() || []).map(v => v.trim().toLowerCase());
  if (!['date', 'name', 'amount'].every(h => headers.includes(h)) || new Set(headers).size !== headers.length || headers.some(h => !['date', 'name', 'amount', 'category', 'id'].includes(h))) throw new Error('Use date,name,amount headers; category and id are optional.');
  if (!rows.length || rows.length > 500) throw new Error('Import 1–500 expenses at a time.');
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Row ${index + 2}: wrong number of columns.`);
    const data = Object.fromEntries(headers.map((h, i) => [h, values[i].trim()]));
    if (!isBudgetDay(data.date) || !data.name || data.name.length > 120 || (data.id || '').length > 120) throw new Error(`Row ${index + 2}: check date, name, and id.`);
    const amount = parseBudgetMoney(data.amount);
    if (!amount) throw new Error(`Row ${index + 2}: expense must be greater than zero.`);
    return { ...data, amount };
  });
}
export async function budgetImportRows(rows, categories) {
  const occurrences = new Map();
  return Promise.all(rows.map(async row => {
    const canonical = JSON.stringify([row.date, row.name, row.amount]);
    const occurrence = (occurrences.get(canonical) || 0) + 1; occurrences.set(canonical, occurrence);
    const identity = row.id ? 'statement:' + row.id : canonical + ':' + occurrence;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)))].map(v => v.toString(16).padStart(2, '0')).join('');
    return { name: row.name, date: row.date, amount: row.amount, category_id: categories.find(c => c.data.name.toLowerCase() === row.category?.toLowerCase())?.id || null, source: 'csv', external_id: 'csv:' + hash, status: 'review' };
  }));
}
