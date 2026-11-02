#!/usr/bin/env node
// One-time setup: `npm run setup`.
// Asks a few questions, creates your Cloudflare D1 database, writes wrangler.jsonc, creates the tables,
// deploys the site and sets your login password. Safe to run again: it reuses what already exists.
//
//   --dry-run   only write the config (to wrangler.dry-run.jsonc); no Cloudflare calls
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';

const DRY = process.argv.includes('--dry-run');
const OUT = DRY ? 'wrangler.dry-run.jsonc' : 'wrangler.jsonc';
const DB_NAME = 'batcave';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
const line = async (prompt) => { process.stdout.write(prompt); const r = await lines.next(); return r.done ? '' : r.value; };
const say = (s = '') => console.log(s);
const step = (s) => say(`\n\x1b[1m${s}\x1b[0m`);
const npx = (args, opts = {}) => spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', ...opts });
const run = (args) => { const r = npx(args, { stdio: 'inherit', env: { ...process.env, CI: '1' } }); if (r.status !== 0) { say(`\nThat step failed: wrangler ${args.join(' ')}`); process.exit(1); } };
async function ask(q, def = '') { const a = (await line(def ? `${q} [${def}] ` : `${q} `)).trim(); return a || def; }
async function yes(q, def = true) { const a = (await line(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase(); return a ? a.startsWith('y') : def; }
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

say('\x1b[1mBatcave setup\x1b[0m: a personal dashboard on Cloudflare (free plan is enough).');

// 1. Cloudflare login
if (!DRY) {
  step('1. Cloudflare account');
  const who = npx(['whoami']);
  if (/not authenticated|You are not logged in/i.test(who.stdout + who.stderr)) {
    say('Opening the Cloudflare login in your browser…');
    run(['login']);
  } else say('Logged in to Cloudflare.');
}

// 2. Your settings
let reuse = false;
if (!DRY && existsSync('wrangler.jsonc')) reuse = await yes('wrangler.jsonc already exists. Keep it and skip to the database step?');
let dbId = null;
if (!reuse) {
  step('2. About you (change any of this later in wrangler.jsonc → vars)');
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  const s = {
    OWNER_NAME: await ask('Your first name:'),
    APP_NAME: await ask('Name for your dashboard:', 'Batcave'),
    ASSISTANT_NAME: await ask('Name for the chat assistant:', 'Alfred'),
    HONORIFIC: await ask('How should the assistant address you (sir, ma\'am, boss, your name…)?', 'sir'),
    TIMEZONE: await ask('Your time zone:', detected),
    TAGLINE: await ask('A motto for the sidebar (optional, Enter to skip):'),
  };
  if (!validTz(s.TIMEZONE)) { say(`"${s.TIMEZONE}" isn't a time zone I know; using ${detected}.`); s.TIMEZONE = detected; }
  const domain = (await ask('Your own domain for it, e.g. cave.example.com (optional, Enter to use workers.dev):')).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  s.CONTACT_EMAIL = await ask('Contact email for the /privacy page (optional; Google asks for one if you connect Google Calendar):');
  s.OWNER_FULL_NAME = s.OWNER_NAME;

  // 3. Database
  step('3. Database');
  if (DRY) dbId = '00000000-0000-0000-0000-000000000000';
  else {
    const list = npx(['d1', 'list', '--json']);
    try { dbId = JSON.parse(list.stdout.slice(list.stdout.indexOf('['))).find((d) => d.name === DB_NAME)?.uuid || null; } catch { /* none yet */ }
    if (dbId) say(`Using your existing D1 database "${DB_NAME}".`);
    else {
      const made = npx(['d1', 'create', DB_NAME]);
      dbId = (made.stdout.match(/"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/i) || [])[1];
      if (!dbId) { say(made.stdout + made.stderr); say('Could not create the database.'); process.exit(1); }
      say(`Created D1 database "${DB_NAME}".`);
    }
  }

  // Write wrangler.jsonc from the example
  let cfg = readFileSync('wrangler.example.jsonc', 'utf8').replace('YOUR_D1_DATABASE_ID', dbId);
  if (domain) cfg = cfg.replace(/\/\/ "routes": \[\{ "pattern": "cave\.example\.com", "custom_domain": true \}\],/, () => `"routes": [{ "pattern": ${JSON.stringify(domain)}, "custom_domain": true }],`);
  for (const [k, v] of Object.entries(s)) cfg = cfg.replace(new RegExp(`("${k}":\\s*)"[^"]*"`), (m, key) => key + JSON.stringify(v));
  writeFileSync(OUT, cfg);
  say(`Wrote ${OUT}.`);
}
if (DRY) { say('\nDry run: nothing was sent to Cloudflare.'); rl.close(); process.exit(0); }

// 4. Tables (+ optional examples)
step('4. Tables');
run(['d1', 'migrations', 'apply', DB_NAME, '--remote']);
if (await yes('Add a few example habits, projects and tasks so it isn\'t empty?')) run(['d1', 'execute', DB_NAME, '--remote', '--file', 'examples/starter.sql']);

// 5. Deploy
step('5. Deploy');
run(['deploy']);

// 6. Password
step('6. Login password');
const generate = !(await yes('Type your own password? (No = make a random passphrase and save it to .site-password)', true));
rl.pause();
const pw = spawnSync('node', ['scripts/set-password.mjs', ...(generate ? ['--generate'] : [])], { stdio: 'inherit' });
rl.resume();
if (pw.status !== 0) { say('Password not set. Run `npm run set-password` later; the site stays locked until you do.'); }

// 7. Optional extras
step('7. Extras (all optional, you can do them later)');
if (await yes('Turn on the chat assistant now? It needs an OpenAI API key.', false)) {
  rl.pause();
  run(['secret', 'put', 'OPENAI_API_KEY']);
  rl.resume();
}
if (await yes('Make a token for the to-do API (phone shortcuts, scripts)?', true)) {
  const token = randomBytes(32).toString('hex');
  const r = npx(['secret', 'put', 'INGEST_TOKEN'], { input: token, stdio: ['pipe', 'ignore', 'inherit'] });
  if (r.status === 0) {
    const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
    if (/^INGEST_TOKEN=/m.test(env)) writeFileSync('.env', env.replace(/^INGEST_TOKEN=.*$/m, `INGEST_TOKEN=${token}`));
    else appendFileSync('.env', `${env && !env.endsWith('\n') ? '\n' : ''}INGEST_TOKEN=${token}\n`);
    say('Saved the token to .env (git-ignored) as INGEST_TOKEN.');
  }
}

rl.close();
say('\n\x1b[1mDone.\x1b[0m Open the URL wrangler printed above and sign in.');
say('Next: Google Calendar sync, the to-do API and iPhone install are in the README.');
