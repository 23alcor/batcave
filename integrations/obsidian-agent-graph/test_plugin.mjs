import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const bundle = readFileSync(new URL('./dist/main.js', import.meta.url), 'utf8');
async function setup() {
  const sockets = [], snapshots = [], states = [];
  const app = { workspace: { getLeavesOfType: () => [] } };
  class Plugin {
    constructor() { this.app=app; this.commands=[]; }
    async loadData() { return { server:'https://first.example', token:'must-not-load-from-vault' }; }
    registerView(_name,factory) { this.factory=factory; }
    addRibbonIcon() {}
    addCommand(command) { this.commands.push(command); }
  }
  class ItemView { constructor(){this.app=app;} }
  class WebSocket {
    constructor(url) { this.url=url; this.sent=[]; this.closed=false; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed=true; }
  }
  const obsidian={Plugin,ItemView,Modal:class{},Notice:class{},requestUrl:async(args)=>{ snapshots.push(args); return {json:{events:[],contexts:[]}}; }};
  const context={module:{exports:{}},require:name=>{assert.equal(name,'obsidian','bundle must not require a relative renderer');return obsidian;},URL,WebSocket,window:{setTimeout,clearTimeout},console};
  vm.runInNewContext(bundle,context);
  const plugin=new context.module.exports();await plugin.onload();
  const view=plugin.factory({});
  view.graph={setStatus:s=>states.push(s),setSnapshot:()=>{},addEvent:()=>{},destroy:()=>{}};
  return {plugin,view,sockets,snapshots,states};
}

test('Plugin bundle loads without external dependencies and never restores a saved connection key',async()=>{
  const {plugin,view,sockets,states}=await setup();
  assert.equal(plugin.token,'');
  await view.connect();
  assert.equal(sockets.length,0);
  assert.equal(states.at(-1),'Not connected');
  assert.ok(plugin.commands.some(c=>c.id==='open-agent-graph'));
});

test('Switching servers cannot send the new key to an old socket; closed views discard snapshots',async()=>{
  const {plugin,view,sockets,snapshots}=await setup();
  plugin.token='first-session-key';await view.connect();const old=sockets[0];
  plugin.server='https://second.example';plugin.token='second-session-key';await view.connect();const current=sockets[1];
  old.onopen();assert.equal(old.sent.length,0);assert.equal(old.closed,true);
  current.onopen();assert.equal(current.url,'wss://second.example/api/agent-graph/stream');
  assert.equal(current.sent[0].token,'second-session-key');
  assert.ok(!current.url.includes('key'));
  await current.onmessage({data:JSON.stringify({type:'connected'})});
  assert.equal(snapshots[0].url,'https://second.example/api/agent-graph');
  assert.equal(snapshots[0].headers.Authorization,'Bearer second-session-key');
  await view.onClose();
  await current.onmessage({data:JSON.stringify({type:'activity',event:{id:1}})});
  assert.equal(view.graph,null);
});
