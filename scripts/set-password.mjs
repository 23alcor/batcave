#!/usr/bin/env node
// Set the Batcave login password.
//
//   npm run set-password                 type a password (hidden), saved as the PASSWORD_HASH secret
//   npm run set-password -- --generate   make a random passphrase, copy it to the clipboard and
//                                        save it to .site-password (git-ignored); never printed
//   add --local to write .dev.vars for `wrangler dev` instead of the live site
//
// The first run also creates SESSION_SECRET. Changing the password signs out every device.
import { pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';

const args = new Set(process.argv.slice(2));
const LOCAL = args.has('--local');
const ITERATIONS = 10000;

function passphrase() {
  let words = [];
  try { words = readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter((w) => /^[a-z]{4,7}$/.test(w)); } catch { /* no dictionary */ }
  if (words.length < 5000) words = 'amber anchor apex arrow aspen atlas autumn badge basil beacon birch blaze bolt brick bronze cabin canyon carbon cedar chalk cipher citrus cobalt comet copper coral cosmic crane crystal dagger delta desert drift ember falcon fern flint forest frost galaxy garnet glacier granite gravel harbor hazel helix hollow indigo iron ivory jade jasper juniper kestrel lagoon lantern lava ledger lemon lunar magnet maple marble meadow mesa meteor mint mirror nebula needle nickel noble north oak oasis obsidian onyx orbit otter pebble pepper pilot pine planet plasma polar prism quartz quill raven reef ridge river rocket saddle sage sierra silver slate solar spark spruce stone storm summit sundial tango thunder tidal timber topaz torch tundra velvet violet vortex walnut willow winter zenith zephyr'.split(' ');
  const pick = () => words[randomInt(words.length)];
  return [pick(), pick(), pick(), pick(), String(randomInt(10, 100))].join('-');
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

function hash(password) {
  const salt = randomBytes(16);
  const dk = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  return `pbkdf2-sha256$${ITERATIONS}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

function putSecret(name, value) {
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], { input: value, stdio: ['pipe', 'ignore', 'inherit'] });
  if (r.status !== 0) { console.error(`Could not set ${name}.`); process.exit(1); }
}

function hasRemoteSecret(name) {
  const r = spawnSync('npx', ['wrangler', 'secret', 'list'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout.slice(r.stdout.indexOf('['))).some((s) => s.name === name); } catch { return false; }
}

function writeDevVars(vars) {
  const lines = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => l && !Object.keys(vars).some((k) => l.startsWith(k + '='))) : [];
  for (const [k, v] of Object.entries(vars)) lines.push(`${k}=${JSON.stringify(v)}`);
  writeFileSync('.dev.vars', lines.join('\n') + '\n', { mode: 0o600 });
}

let password;
if (args.has('--generate')) {
  password = passphrase();
  writeFileSync('.site-password', password + '\n', { mode: 0o600 });
  const copied = process.platform === 'darwin' && spawnSync('pbcopy', { input: password }).status === 0;
  console.log(`New password saved to .site-password${copied ? ' and copied to the clipboard' : ''}.`);
} else {
  password = await ask('New password: ');
  if (password.length < 10) { console.error('Use at least 10 characters.'); process.exit(1); }
  if ((await ask('Again: ')) !== password) { console.error('Passwords did not match.'); process.exit(1); }
}

const passwordHash = hash(password);
if (LOCAL) {
  const existing = existsSync('.dev.vars') && /^SESSION_SECRET=/m.test(readFileSync('.dev.vars', 'utf8'));
  writeDevVars({ PASSWORD_HASH: passwordHash, ...(existing ? {} : { SESSION_SECRET: randomBytes(32).toString('base64') }) });
  console.log('Updated .dev.vars for wrangler dev.');
} else {
  if (!hasRemoteSecret('SESSION_SECRET')) putSecret('SESSION_SECRET', randomBytes(32).toString('base64'));
  putSecret('PASSWORD_HASH', passwordHash);
  console.log('Password updated on the live site. Every device has to sign in again.');
}
