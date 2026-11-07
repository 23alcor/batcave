// Lets the scripts/test-*.mjs suites load the Worker in plain Node (`npm test`): Node has no `cloudflare:workers`
// module and doesn't import .sql files as text the way wrangler does.
import { register } from 'node:module';

const hooks = `
import { readFile } from 'node:fs/promises';
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url.endsWith('.sql')) return { format: 'module', source: 'export default ' + JSON.stringify(await readFile(new URL(url), 'utf8')), shortCircuit: true };
  return next(url, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));
