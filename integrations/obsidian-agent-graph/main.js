const { Plugin, ItemView, Modal, Notice, requestUrl } = require('obsidian');
const { AgentGraph } = require('./graph');
const VIEW = 'bat-vault-agent-graph';

function serverOrigin(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname)))) throw new Error('Use an HTTPS Batcave address.');
  return u.origin;
}

class ConnectionModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() {
    this.titleEl.setText('Connect Agent Graph');
    const form = this.contentEl.createEl('form', { cls: 'ag-connect-form' });
    const addressLabel = form.createEl('label', { text: 'Batcave address' });
    const address = addressLabel.createEl('input', { type: 'url', value: this.plugin.server || '', placeholder: 'https://your-batcave.example' });
    address.required = true;
    const keyLabel = form.createEl('label', { text: 'MCP connection key' });
    const key = keyLabel.createEl('input', { type: 'password' });
    key.required = true; key.autocomplete = 'off'; key.spellcheck = false;
    form.createEl('p', { text: 'Use the existing MCP key from your Batcave configuration. The key stays in memory for this Obsidian session; it is never saved to the vault.' });
    const error = form.createEl('p', { attr: { role: 'alert' } });
    form.createEl('button', { type: 'submit', text: 'Connect' });
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const server = serverOrigin(address.value);
        const token = key.value.trim();
        if (!token) throw new Error('Enter the connection key.');
        await requestUrl({ url: server + '/api/agent-graph', headers: { Authorization: 'Bearer ' + token } });
        this.plugin.server = server; this.plugin.token = token;
        await this.plugin.saveData({ server });
        key.value = ''; this.close();
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) leaf.view.connect();
      } catch { error.setText('Could not connect. Check the address, key, and whether the Agent Graph backend is deployed.'); }
    };
  }
  onClose() { this.contentEl.empty(); }
}

class GraphView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.retry = 0; this.generation = 0; }
  getViewType() { return VIEW; }
  getDisplayText() { return 'Agent Graph'; }
  getIcon() { return 'git-fork'; }
  async onOpen() {
    this.contentEl.addClass('ag-host');
    this.graph = new AgentGraph(this.contentEl, {
      openNote: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path.split('#')[0]);
        if (!file || file.extension !== 'md') { new Notice('This note is not available locally yet. Wait for vault sync.'); return; }
        try { await this.app.workspace.openLinkText(path, '', true); }
        catch { new Notice('Could not open this note.'); }
      },
      connect: () => new ConnectionModal(this.app, this.plugin).open(),
    });
    this.rebuildGraph();
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.rebuildGraph()));
    this.registerEvent(this.app.vault.on('rename', () => this.rebuildGraph()));
    this.registerEvent(this.app.vault.on('delete', () => this.rebuildGraph()));
    this.registerInterval(window.setInterval(() => {
      this.graph?.renderActivity(); this.graph?.draw();
      if (this.socket?.readyState === WebSocket.OPEN) {
        if (Date.now() - this.lastMessage > 45000) this.socket.close();
        else this.socket.send('ping');
      }
    }, 15000));
    await this.connect();
  }
  rebuildGraph() {
    const files = this.app.vault.getMarkdownFiles().filter((f) => !f.path.split('/').some((p) => p.startsWith('.') || ['Templates','Transcripts'].includes(p)));
    const paths = new Set(files.map((f) => f.path)), links = [];
    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (!paths.has(source)) continue;
      for (const target of Object.keys(targets)) if (paths.has(target)) links.push({ source, target });
    }
    this.graph.setGraph(files.map((f) => ({ path: f.path, title: f.basename })), links);
  }
  async snapshot(generation = this.generation, server = this.plugin.server, token = this.plugin.token) {
    const result = await requestUrl({ url: server + '/api/agent-graph', headers: { Authorization: 'Bearer ' + token } });
    if (this.graph && generation === this.generation) this.graph.setSnapshot(result.json);
  }
  async connect() {
    const generation = ++this.generation;
    window.clearTimeout(this.retry); this.socket?.close();
    if (!this.plugin.server || !this.plugin.token) { this.graph.setStatus('Not connected'); return; }
    this.graph.setStatus('Connecting…');
    const server = this.plugin.server, token = this.plugin.token;
    const socket = new WebSocket(server.replace(/^http/, 'ws') + '/api/agent-graph/stream');
    this.socket = socket; this.lastMessage = Date.now();
    socket.onopen = () => { if (generation === this.generation) socket.send(JSON.stringify({ type: 'authenticate', token })); else socket.close(); };
    socket.onmessage = async (message) => {
      if (generation !== this.generation) return;
      this.lastMessage = Date.now();
      if (message.data === 'pong') return;
      try {
        const data = JSON.parse(message.data);
        if (data.type === 'connected') {
          await this.snapshot(generation, server, token);
          if (generation === this.generation) this.graph.setStatus('Live', true);
        } else if (data.type === 'activity') {
          this.graph.addEvent(data.event);
          if (['save_requested','file_saved'].includes(data.event.action)) await this.snapshot(generation, server, token);
        }
      } catch { if (generation === this.generation) this.graph?.setStatus('Sync interrupted'); }
    };
    socket.onclose = (event) => {
      if (generation !== this.generation || !this.graph) return;
      this.graph.setStatus(event.code === 1008 ? 'Key rejected' : 'Reconnecting…');
      if (event.code !== 1008) this.retry = window.setTimeout(() => this.connect(), 5000);
    };
    socket.onerror = () => { if (generation === this.generation) this.graph?.setStatus('Connection interrupted'); };
  }
  async onClose() {
    ++this.generation; window.clearTimeout(this.retry); this.socket?.close(); this.graph?.destroy(); this.graph = null;
  }
}

module.exports = class AgentGraphPlugin extends Plugin {
  async onload() {
    const settings = await this.loadData();
    try { this.server = settings?.server ? serverOrigin(settings.server) : ''; } catch { this.server = ''; }
    this.token = '';
    this.registerView(VIEW, (leaf) => new GraphView(leaf, this));
    this.addRibbonIcon('git-fork', 'Open Agent Graph', () => this.openGraph());
    this.addCommand({ id: 'open-agent-graph', name: 'Open Agent Graph', callback: () => this.openGraph() });
    this.addCommand({ id: 'connect-agent-graph', name: 'Connect to Batcave', callback: () => new ConnectionModal(this.app, this).open() });
    this.addCommand({ id: 'disconnect-agent-graph', name: 'Disconnect from Batcave', callback: () => {
      this.token = ''; for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) leaf.view.connect(); new Notice('Agent Graph disconnected');
    } });
  }
  async openGraph() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW)[0] || this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW, active: true }); this.app.workspace.revealLeaf(leaf);
  }
  onunload() { this.token = ''; }
};
