import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const here = new URL('./', import.meta.url);
mkdirSync(new URL('dist/', here), { recursive: true });
const main = readFileSync(new URL('main.js', here), 'utf8');
if (!main.includes("require('./graph')")) throw new Error('Graph renderer import not found');
writeFileSync(new URL('dist/main.js', here), readFileSync(new URL('graph.js', here), 'utf8') + '\n' + main.replace("require('./graph')", 'module.exports'));
copyFileSync(new URL('manifest.json', here), new URL('dist/manifest.json', here));
copyFileSync(new URL('styles.css', here), new URL('dist/styles.css', here));
console.log('Built dist/main.js, manifest.json and styles.css');
