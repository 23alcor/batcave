/* Shared renderer: Obsidian hosts this view; the browser harness exercises the same code. */
(function (root) {
  const NS = 'http://www.w3.org/2000/svg';
  const colors = ['#f0c75e', '#71b7cd', '#d999ab', '#a5c18a'];
  const el = (tag, cls, text, parent) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    parent?.appendChild(n);
    return n;
  };
  const svg = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    parent?.appendChild(n);
    return n;
  };
  const titleOf = (path) => path.split('/').pop().replace(/\.md$/, '');
  const labelOf = (e) => ({ read_note: 'Read', search_notes: 'Searched', related_notes: 'Followed links', list_notes: 'Listed notes', recent_sessions: 'Read sessions', resume_project: 'Resumed project', resume_task: 'Resumed task', whoami: 'Read background', save_requested: 'Save requested', file_saved: 'File saved' }[e.action] || e.action);
  const short = (s, n = 29) => s.length > n ? s.slice(0, n - 1) + '…' : s;

  class AgentGraph {
    constructor(container, { openNote, connect } = {}) {
      this.openNote = openNote || (() => {});
      this.connect = connect || (() => {});
      this.events = []; this.contexts = []; this.nodes = []; this.links = []; this.project = ''; this.task = ''; this.focus = '';
      this.root = el('section', 'agent-graph', null, container);
      const head = el('header', 'ag-header', null, this.root);
      const identity = el('div', 'ag-identity', null, head);
      el('span', 'ag-mark', '⋈', identity).setAttribute('aria-hidden', 'true');
      const heading = el('div', '', null, identity);
      el('div', 'ag-workspace', 'Bat Vault · note activity', heading);
      el('h1', '', 'Agent Graph', heading);
      this.status = el('span', 'ag-status', 'Disconnected', head);
      this.status.setAttribute('role', 'status');
      const connectButton = el('button', 'ag-button', 'Connect', head);
      connectButton.onclick = () => this.connect();
      const tools = el('div', 'ag-toolbar', null, this.root);
      this.projects = this.select(tools, 'Project', (value) => { this.project = value; this.task = ''; this.updateFilters(); this.draw(); this.renderActivity(); });
      this.tasks = this.select(tools, 'Task', (value) => { this.task = value; this.draw(); this.renderActivity(); });
      this.summary = el('span', 'ag-summary', '', tools);
      const body = el('div', 'ag-body', null, this.root);
      const plot = el('section', 'ag-plot', null, body);
      this.canvas = svg('svg', { viewBox: '0 0 900 620', role: 'group', 'aria-label': 'Note graph. Click a note to open it. Use arrow keys to pan and plus or minus to zoom.', tabindex: '0' }, plot);
      this.camera = { x: 0, y: 0, w: 900, h: 620 };
      this.world = svg('g', {}, this.canvas);
      this.legend = el('div', 'ag-legend', '● Read   ◇ File saved   ┄ Agent trail', plot);
      const zoom = el('div', 'ag-zoom', null, plot);
      for (const [text, name, action] of [['+', 'Zoom in', () => this.zoom(.8)], ['−', 'Zoom out', () => this.zoom(1.25)], ['Fit', 'Fit graph', () => { this.camera = { x: 0, y: 0, w: this.compact ? 400 : 900, h: this.compact ? 400 : 620 }; this.setCamera(); }]]) {
        const b = el('button', 'ag-button', text, zoom); b.setAttribute('aria-label', name); b.onclick = action;
      }
      this.empty = el('div', 'ag-empty', '', plot);
      this.rail = el('aside', 'ag-rail', null, body);
      el('h2', '', 'Agents', this.rail);
      this.agents = el('div', 'ag-agents', null, this.rail);
      el('h2', 'ag-activity-heading', 'Recent activity', this.rail);
      this.feed = el('ol', 'ag-feed', null, this.rail);
      const footer = el('footer', 'ag-footer', null, this.root);
      this.selection = el('span', '', 'Select a note to open it in the vault.', footer);
      this.freshness = el('span', '', '', footer);
      this.canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.12 : .89); }, { passive: false });
      this.canvas.addEventListener('keydown', (e) => {
        if (e.target !== this.canvas) return;
        const moves = { ArrowLeft: [-30, 0], ArrowRight: [30, 0], ArrowUp: [0, -30], ArrowDown: [0, 30] };
        if (moves[e.key]) { e.preventDefault(); this.camera.x += moves[e.key][0]; this.camera.y += moves[e.key][1]; this.setCamera(); }
        if (e.key === '+' || e.key === '-') { e.preventDefault(); this.zoom(e.key === '+' ? .8 : 1.25); }
      });
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(this.root);
      this.root.addEventListener('pointerover', (e) => { const n = e.target.closest('[data-note]'); if (n) this.selection.textContent = n.getAttribute('data-note'); });
    }
    select(parent, name, change) {
      const label = el('label', 'ag-filter', name, parent), select = el('select', '', null, label);
      select.setAttribute('aria-label', name); select.onchange = () => change(select.value);
      return select;
    }
    setCamera() { const c = this.camera; this.canvas.setAttribute('viewBox', `${c.x} ${c.y} ${c.w} ${c.h}`); }
    zoom(scale) {
      const c = this.camera, w = Math.min(2400, Math.max(200, c.w * scale)), h = w * (this.compact ? 1 : 620 / 900);
      this.camera = { x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h }; this.setCamera();
    }
    setStatus(text, connected = false) { this.status.textContent = text; this.status.dataset.connected = String(connected); }
    setGraph(nodes, links) { this.nodes = nodes; this.links = links; this.draw(); }
    updateFilters() {
      const replace = (select, names, value, all) => {
        select.replaceChildren();
        for (const [v, text] of [['', all], ...names.map((s) => [s, s])]) { const o = el('option', '', text, select); o.value = v; }
        select.value = value;
      };
      replace(this.projects, [...new Set([...this.contexts, ...this.events].map((x) => x.project).filter(Boolean))].sort(), this.project, 'All projects');
      replace(this.tasks, [...new Set([...this.contexts, ...this.events].filter((x) => !this.project || x.project === this.project).map((x) => x.task).filter(Boolean))].sort(), this.task, 'All tasks');
    }
    setSnapshot(data) {
      this.contexts = data.contexts || [];
      const all = new Map(this.events.map((e) => [e.id, e]));
      for (const e of data.events || []) all.set(e.id, e);
      this.events = [...all.values()].sort((a, b) => a.id - b.id).slice(-200);
      this.updateFilters(); this.draw(); this.renderActivity();
    }
    addEvent(event) {
      if (this.events.some((e) => e.id === event.id)) return;
      this.events.push(event); this.events.sort((a, b) => a.id - b.id); this.events = this.events.slice(-200);
      this.updateFilters(); this.draw(); this.renderActivity();
    }
    colorFor(id) { this.agentColors ||= new Map(); if (!this.agentColors.has(id)) this.agentColors.set(id, colors[this.agentColors.size % colors.length]); return this.agentColors.get(id); }
    visibleEvents() { return this.events.filter((e) => (!this.project || e.project === this.project) && (!this.task || e.task === this.task)); }
    draw() {
      this.world.replaceChildren();
      const plot = this.canvas.parentElement;
      const compact = plot.clientWidth < 600;
      if (compact !== this.compact) { this.compact = compact; this.camera = { x: 0, y: 0, w: compact ? 400 : 900, h: compact ? 400 : 620 }; this.setCamera(); }
      const scale = Math.min(plot.clientWidth / (compact ? 400 : 900), plot.clientHeight / (compact ? 400 : 620));
      this.world.style.setProperty('--ag-label-scale', String(1 / Math.max(.2, scale)));
      const events = this.visibleEvents();
      const contexts = this.contexts.filter((c) => (!this.project || c.project === this.project) && (!this.task || c.task === this.task));
      const bookmarks = new Set(contexts.map((c) => c.entry_note.split('#')[0]));
      const recent = new Set(events.slice(-30).flatMap((e) => e.paths));
      let candidates = this.nodes;
      if (this.project || this.task) {
        const anchors = new Set([...bookmarks, ...recent]);
        const scope = new Set(anchors);
        for (const l of this.links) { if (anchors.has(l.source)) scope.add(l.target); if (anchors.has(l.target)) scope.add(l.source); }
        candidates = candidates.filter((n) => scope.has(n.path));
      }
      const degree = new Map();
      for (const l of this.links) for (const p of [l.source, l.target]) degree.set(p, (degree.get(p) || 0) + 1);
      candidates = [...candidates].sort((a, b) => Number(recent.has(b.path)) - Number(recent.has(a.path)) || Number(bookmarks.has(b.path)) - Number(bookmarks.has(a.path)) || (degree.get(b.path) || 0) - (degree.get(a.path) || 0) || a.path.localeCompare(b.path));
      const nodes = candidates.slice(0, 400), positions = new Map();
      const groups = [...new Set(nodes.map((n) => n.path.includes('/') ? n.path.split('/')[0] : 'Vault'))].sort();
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g], theta = g * Math.PI * 2 / Math.max(groups.length, 1) - Math.PI / 2;
        const angle = groups.length === 2 && !compact ? g * Math.PI : theta;
        const cx = (compact ? 200 : 450) + (groups.length === 1 ? 0 : Math.cos(angle) * (compact ? 115 : 265));
        const cy = (compact ? 180 : 295) + (groups.length === 1 ? 0 : Math.sin(angle) * (compact ? 100 : 195));
        const members = nodes.filter((n) => (n.path.includes('/') ? n.path.split('/')[0] : 'Vault') === group).sort((a,b) => a.path.localeCompare(b.path));
        svg('text', { x: cx, y: cy - (compact ? 68 : 105), 'text-anchor': 'middle', class: 'ag-cluster-label' }, this.world).textContent = short(group, 30);
        members.forEach((n, i) => {
          const r = members.length === 1 ? 0 : 20 + Math.sqrt(i / Math.max(1, members.length - 1)) * (groups.length === 1 ? (compact ? 120 : 190) : (compact ? 42 : 83));
          const a = i * 2.399963;
          positions.set(n.path, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, node: n });
        });
      }
      this.positions = positions;
      for (const l of this.links) {
        const a = positions.get(l.source), b = positions.get(l.target);
        if (a && b) svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'ag-edge' }, this.world);
      }
      const sessions = [...new Set(events.map((e) => e.session_id || 'unidentified'))];
      sessions.forEach((id, i) => {
        const history = events.filter((e) => (e.session_id || 'unidentified') === id && (e.action === 'read_note' || e.action.startsWith('resume_') || e.action === 'file_saved'));
        const visited = history.flatMap((e) => e.paths.slice(0, 1)).filter((p) => positions.has(p)).slice(-8);
        if (visited.length > 1) svg('polyline', { points: visited.map((p) => { const n=positions.get(p); return `${n.x},${n.y}`; }).join(' '), class: 'ag-trail', stroke: this.colorFor(id), opacity: this.focus && id !== this.focus ? '.15' : '.6' }, this.world);
      });
      const named = new Set(nodes.slice(0, compact ? 4 : 12).map((n) => n.path));
      for (const [path, p] of positions) {
        const bookmarked = bookmarks.has(path), active = recent.has(path);
        const g = svg('g', { transform: `translate(${p.x} ${p.y})`, class: 'ag-node', role: 'button', tabindex: '0', 'aria-label': 'Open ' + p.node.title, 'data-note': path }, this.world);
        svg('circle', { r: bookmarked ? 6 : 3.5, class: bookmarked ? 'ag-bookmark' : active ? 'ag-note-recent' : 'ag-note' }, g);
        svg('title', {}, g).textContent = path;
        if (bookmarked) svg('text', { x: -3, y: 3, class: 'ag-bookmark-symbol' }, g).textContent = '◆';
        if (bookmarked || active || named.has(path)) svg('text', { x: 10, y: 4, class: 'ag-note-label' }, g).textContent = short(p.node.title);
        g.addEventListener('click', () => this.openNote(path));
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openNote(path); } });
      }
      sessions.forEach((id, i) => {
        const history = events.filter((e) => (e.session_id || 'unidentified') === id && ['read_note','whoami','resume_project','resume_task','file_saved'].includes(e.action) && e.paths.some((p) => positions.has(p)));
        const last = history.at(-1); if (!last || Date.now() - Date.parse(last.at) > 300000) return;
        const path = last.paths.find((p) => positions.has(p)), to = positions.get(path);
        const previous = history.slice(0,-1).reverse().find((e) => ['read_note','whoami','resume_project','resume_task','file_saved'].includes(e.action) && e.paths.some((p) => positions.has(p)));
        const from = previous ? positions.get(previous.paths.find((p) => positions.has(p))) : to;
        const marker = svg('g', { class: 'ag-agent-marker', opacity: this.focus && this.focus !== id ? '.2' : '1' }, this.world);
        const saved = last.action === 'file_saved';
        if (saved) svg('path', { d: 'M 0 -10 L 10 0 L 0 10 L -10 0 Z', fill: this.colorFor(id), class: 'ag-write-mark' }, marker);
        else svg('circle', { r: 9, fill: 'none', stroke: this.colorFor(id), 'stroke-width': 2.5, class: 'ag-read-mark' }, marker);
        svg('text', { x: 13, y: -12, fill: this.colorFor(id), class: 'ag-agent-label' }, marker).textContent = short(last.agent, 20);
        svg('title', {}, marker).textContent = `${last.agent}: ${labelOf(last)} ${titleOf(path)}`;
        const move = last.id !== this.lastAnimated?.[id] && Date.now() - Date.parse(last.at) < 10000 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
        marker.setAttribute('transform', `translate(${move ? from.x : to.x} ${move ? from.y : to.y})`);
        if (move) {
          const start = performance.now();
          const frame = (now) => {
            if (!marker.isConnected) return;
            const t = Math.min(1, (now - start) / 650), eased = t * (2 - t);
            marker.setAttribute('transform', `translate(${from.x+(to.x-from.x)*eased} ${from.y+(to.y-from.y)*eased})`);
            if (t < 1) requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }
        this.lastAnimated ||= {}; this.lastAnimated[id] = last.id;
      });
      this.summary.textContent = `${nodes.length}${candidates.length > nodes.length ? ' of ' + candidates.length : ''} notes · ${bookmarks.size} bookmark${bookmarks.size === 1 ? '' : 's'}`;
      this.empty.textContent = nodes.length ? '' : this.project ? 'No linked notes or activity for this task yet.' : 'No notes in this vault yet.';
      this.empty.hidden = Boolean(nodes.length);
    }
    renderActivity() {
      const events = this.visibleEvents(), latest = new Map();
      for (const e of events) latest.set(e.session_id || 'unidentified', e);
      this.agents.replaceChildren(); this.feed.replaceChildren();
      if (!latest.size) el('p', 'ag-muted', 'No agent activity yet. Resume a task through MCP to start a trail.', this.agents);
      [...latest].sort(([,a],[,b]) => b.id - a.id).slice(0, 8).forEach(([id, e], i) => {
        const button = el('button', 'ag-agent-row', null, this.agents);
        button.style.setProperty('--agent-color', this.colorFor(id));
        button.setAttribute('aria-pressed', String(this.focus === id));
        el('span', 'ag-agent-dot', '', button);
        const text = el('span', '', null, button);
        el('strong', '', e.agent, text);
        const active = Date.now() - Date.parse(e.at) < 60000;
        el('small', '', `${active ? 'Active' : 'Last seen'} · ${e.task || e.project || 'Unscoped'}`, text);
        button.onclick = () => { this.focus = this.focus === id ? '' : id; this.draw(); this.renderActivity(); };
      });
      for (const e of events.slice(-8).reverse()) {
        const row = el('li', '', null, this.feed);
        const line = el('div', 'ag-event-top', null, row);
        el('span', '', labelOf(e), line);
        const time = el('time', '', new Date(e.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}), line); time.dateTime=e.at;
        el('div', 'ag-event-agent', e.agent + (e.task ? ' · ' + e.task : ''), row);
        if (e.paths.length) { const b=el('button', 'ag-note-link', titleOf(e.paths[0]), row); b.onclick=()=>this.openNote(e.paths[0]); }
        else el('span', 'ag-muted', e.status === 'queued' ? 'Waiting for the vault bridge' : 'No note returned', row);
      }
      const last = events.at(-1);
      this.freshness.textContent = last ? 'Latest activity ' + new Date(last.at).toLocaleTimeString() : 'Waiting for activity';
    }
    destroy() { this.resizeObserver.disconnect(); this.root.remove(); }
  }
  if (typeof module !== 'undefined') module.exports = { AgentGraph };
  else root.AgentGraph = AgentGraph;
})(typeof window !== 'undefined' ? window : globalThis);
