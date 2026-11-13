// Each friend's data lives in their own SQLite database: a Durable Object per user. The owner keeps using D1.
// userDB() returns an object shaped like the D1 binding (prepare/bind/first/all/run/batch), so every handler
// runs against either one. Only explicit wishlist sharing resolves to another person's wishlist.
import { DurableObject } from 'cloudflare:workers';
import m1 from '../migrations/0001_init.sql';
import m3 from '../migrations/0003_google.sql';
import m4 from '../migrations/0004_habit_cadence.sql';
import m5 from '../migrations/0005_transcripts.sql';
import m6 from '../migrations/0006_drop_links.sql';
import m7 from '../migrations/0007_recipes.sql';
import m9 from '../migrations/0009_eating_out.sql';
import m12 from '../migrations/0012_wishlist_media.sql';
import m14 from '../migrations/0014_vault_notes.sql';
import m17 from '../migrations/0017_budget.sql';
import m18 from '../migrations/0018_wishlist_added_by.sql';

// Per-user schema, applied in order. A new migration that changes per-user tables goes here too (append only).
// 0002 (login lockout) and 0008 (accounts) are install-wide and stay in D1.
const MIGRATIONS = [m1, m3, m4, m5, m6, m7, m9, m12, m14, m17, m18];

export class UserDB extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      const done = (await ctx.storage.get('schema')) || 0;
      if (done >= MIGRATIONS.length) return;
      ctx.storage.transactionSync(() => { for (const m of MIGRATIONS.slice(done)) this.sql.exec(m); });
      await ctx.storage.put('schema', MIGRATIONS.length);
    });
  }
  // Runs statements in one transaction and answers like D1: [{ results, meta: { changes } }].
  query(stmts) {
    return this.ctx.storage.transactionSync(() => stmts.map(({ sql, params }) => {
      const results = this.sql.exec(sql, ...params).toArray();
      const changes = /^\s*(insert|update|delete|replace)\b/i.test(sql) ? this.sql.exec('SELECT changes() AS n').one().n : 0;
      return { results, meta: { changes } };
    }));
  }
  size() { return this.sql.databaseSize; }
}

export const userStub = (env, id) => env.USERDB.get(env.USERDB.idFromName('user:' + id));

export function userDB(stub) {
  const one = async (sql, params) => (await stub.query([{ sql, params }]))[0];
  const stmt = (sql, params = []) => ({
    sql, params,
    bind: (...p) => stmt(sql, p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v))),
    all: () => one(sql, params),
    run: () => one(sql, params),
    first: async (col) => { const row = (await one(sql, params)).results[0] ?? null; return col && row ? row[col] : row; },
  });
  return { prepare: (sql) => stmt(sql), batch: (list) => stub.query(list.map(({ sql, params }) => ({ sql, params }))) };
}
