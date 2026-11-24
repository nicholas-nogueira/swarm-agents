/**
 * board.html: visão do swarm em grafo (equivalente à aba Graph do painel do Antigravity).
 * Arquivo estático, sem servidor: o board.mjs regera a página a cada escrita e ela
 * se recarrega sozinha a cada 3 s enquanto está "Ao vivo" e o swarm não terminou.
 * Texto de posts é dado não confiável: entra só via JSON escapado e textContent.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGraph, COORDINATOR } from './board-core.mjs';
import { collectUsage } from './usage.mjs';

export const HTML_FILE = 'board.html';
export const RELOAD_MS = 3000;

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// JSON seguro dentro de <script>: nenhum "<" literal sobra, então "</script>" não fecha a tag.
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');

export function isFinished(posts) {
  const last = [...posts].reverse().find((p) => p.agent === COORDINATOR);
  return Boolean(last && /^\[(done|stopped)\]/.test(last.text || ''));
}

export function renderHtml({ roster, posts, generatedAt, usage = null }) {
  const data = {
    title: roster.title, backend: roster.backend, members: roster.members, posts,
    generatedAt, finished: isFinished(posts), reloadMs: RELOAD_MS, usage,
  };
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swarm · ${escHtml(roster.title)}</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#e3e3e0;--edge:#8a8a92;--sel:#d9480f;
--coord:#5b5bd6;--worker:#2f9e6e;--verifier:#c2410c;--killed:#b8b8bd;--chip:#efefec}
@media (prefers-color-scheme: dark){:root{--bg:#141416;--panel:#1c1c1f;--ink:#ececef;--muted:#9a9aa3;--line:#2c2c31;--edge:#6e6e78;
--sel:#ff8a4c;--coord:#8b8bf0;--worker:#4cc392;--verifier:#f08a50;--killed:#55555c;--chip:#26262b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{font-size:16px;margin:0;font-weight:600}.muted{color:var(--muted)}.chip{background:var(--chip);border-radius:999px;padding:2px 10px;font-size:12px}
.controls{display:flex;gap:8px;align-items:center;margin-left:auto;flex-wrap:wrap}
button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:4px 10px;cursor:pointer}
button.on{border-color:var(--worker);color:var(--worker)}input[type=range]{width:180px}
main{display:grid;grid-template-columns:minmax(0,1fr) 380px;min-height:calc(100vh - 58px)}
@media (max-width:900px){main{grid-template-columns:1fr}}
#graph{width:100%;height:100%;min-height:420px}aside{border-left:1px solid var(--line);background:var(--panel);overflow:auto;max-height:calc(100vh - 58px)}
table.use{width:calc(100% - 32px);margin:0 16px 8px;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
table.use th,table.use td{padding:4px 6px;border-bottom:1px solid var(--line);text-align:right}
table.use th:first-child,table.use td:first-child,table.use td:nth-child(2){text-align:left}
table.use tr.total td{font-weight:600;border-bottom:none}.note{margin:0 16px 8px;font-size:11px;color:var(--muted)}
aside h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:14px 16px 6px}
.post{padding:8px 16px;border-top:1px solid var(--line);white-space:pre-wrap;word-break:break-word}.post b{font-weight:600}
.post .meta{color:var(--muted);font-size:12px}.legend{display:flex;gap:12px;padding:0 16px 8px;font-size:12px;color:var(--muted)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:-1px}
.node{cursor:pointer}.node text{fill:var(--ink);font-size:12px;text-anchor:middle}.edge{cursor:pointer;fill:none}
.edge-label{fill:var(--muted);font-size:11px;text-anchor:middle}@keyframes pulse{0%,100%{stroke-opacity:1}50%{stroke-opacity:.25}}
.working{animation:pulse 1.4s ease-in-out infinite}
</style>
</head>
<body>
<header>
  <h1 id="title"></h1><span class="chip" id="backend"></span><span class="chip" id="cost" title="Custo estimado pelo models.json"></span><span class="muted" id="updated"></span>
  <div class="controls">
    <button id="live" title="Recarrega a cada 3 s">Ao vivo</button>
    <button id="play" title="Reproduz a conversa do #1 ao fim">▶ Replay</button>
    <input type="range" id="seq" min="0" value="0" aria-label="Até o post #">
    <span id="seqLabel" class="muted"></span>
  </div>
</header>
<main>
  <svg id="graph" viewBox="0 0 800 600" role="img" aria-label="Grafo de comunicação do swarm">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>
    <g id="edges"></g><g id="nodes"></g>
  </svg>
  <aside>
    <div class="legend"><span><i class="dot" style="background:var(--coord)"></i>coordinator</span>
      <span><i class="dot" style="background:var(--worker)"></i>worker</span>
      <span><i class="dot" style="background:var(--verifier)"></i>verifier</span><span>- - - brief</span></div>
    <h2>Consumo por agente (estimativa)</h2><div id="usage"></div>
    <h2 id="panelTitle">Board</h2><div id="feed"></div>
  </aside>
</main>
<script type="application/json" id="data">${safeJson(data)}</script>
<script>
${buildGraph.toString()}
const D = JSON.parse(document.getElementById('data').textContent);
const head = D.posts.length ? D.posts[D.posts.length - 1].seq : 0;
const H = new URLSearchParams(location.hash.slice(1));
const S = { live: H.get('live') !== '0', seq: H.has('seq') ? Math.min(+H.get('seq'), head) : head, sel: H.get('sel') || '' };
if (S.live) S.seq = head;
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; };
const color = (n) => n.state === 'killed' ? 'var(--killed)' : n.role === 'coordinator' ? 'var(--coord)' : n.role === 'verifier' ? 'var(--verifier)' : 'var(--worker)';
const hhmm = (t) => { const d = new Date(t); return isNaN(d) ? '--:--' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };

function save() { const h = new URLSearchParams({ live: S.live ? '1' : '0', seq: String(S.seq) }); if (S.sel) h.set('sel', S.sel); history.replaceState(null, '', '#' + h); }

function layout(nodes) {
  const pos = {}; const cx = 400, cy = 300;
  const ring = nodes.filter((n) => n.name !== 'coordinator');
  if (nodes.some((n) => n.name === 'coordinator')) pos.coordinator = { x: cx, y: cy };
  const r = ring.length > 8 ? 250 : 210;
  ring.forEach((n, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(ring.length, 1); pos[n.name] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; });
  return pos;
}

const U = (D.usage && D.usage.members) || {};
const short = (id) => String(id).replace(/^claude-/, '');
const usd = (c) => c === null || c === undefined ? 'sem preço' : 'US$ ' + c.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const tok = (n) => n >= 1e6 ? (n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + 'M' : n >= 1e3 ? (n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'k' : String(n);
const maxCost = Math.max(0, ...Object.values(U).map((u) => u.cost || 0));
// Raio pelo custo: quem gastou mais aparece maior (área proporcional).
function R(name) { const c = (U[name] && U[name].cost) || 0; return maxCost > 0 ? 20 + 20 * Math.sqrt(c / maxCost) : 26; }
function modelLine(name) {
  const u = U[name], m = (D.members[name] || {});
  const model = u && u.models.length ? u.models.map(short).join('+') : m.model && m.model !== 'inherit' ? m.model + ' (pedido)' : '';
  const effort = (u && u.lastEffort) || m.effort || '';
  const parts = [model, effort && 'effort ' + effort, u && usd(u.cost)].filter(Boolean);
  return parts.join(' · ');
}
function usageTable() {
  const box = $('usage'); box.textContent = '';
  const names = Object.keys(U);
  if (!names.length) { const p = document.createElement('p'); p.className = 'note'; p.textContent = 'Sem dados de consumo ainda (aparecem quando os agentes respondem).'; box.appendChild(p); return; }
  const t = document.createElement('table'); t.className = 'use';
  const row = (cells, cls) => { const tr = document.createElement('tr'); if (cls) tr.className = cls; for (const c of cells) { const td = document.createElement(cls === 'head' ? 'th' : 'td'); td.textContent = c; tr.appendChild(td); } t.appendChild(tr); };
  row(['Agente', 'Modelo', 'Effort', 'Saída', 'Cache lido', 'Custo'], 'head');
  for (const n of names) { const u = U[n]; const eff = Object.entries(u.efforts || {}).map(([k, v]) => k + (Object.keys(u.efforts).length > 1 ? '×' + v : '')).join(' ') || '-'; row([n, u.models.map(short).join('+'), eff, tok(u.tokens.output), tok(u.tokens.cacheRead), usd(u.cost) + (u.unpriced ? '+' : '')]); }
  const T = D.usage.total; row(['Total', '', '', tok(T.tokens.output), tok(T.tokens.cacheRead), usd(T.cost) + (T.unpriced ? '+' : '')], 'total');
  box.appendChild(t);
  const note = document.createElement('p'); note.className = 'note'; note.textContent = 'Custo é estimativa pelo models.json (preços oficiais por modelo); o valor real é o do seu plano. Coordinator conta a partir do início do swarm.'; box.appendChild(note);
}

function draw() {
  const g = buildGraph(D.members, D.posts, S.seq);
  const pos = layout(g.nodes);
  const E = $('edges'), N = $('nodes'); E.textContent = ''; N.textContent = '';
  for (const e of g.edges) {
    const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const sx = a.x + ux * (R(e.from) + 4), sy = a.y + uy * (R(e.from) + 4), tx = b.x - ux * (R(e.to) + 6), ty = b.y - uy * (R(e.to) + 6);
    const mx = (sx + tx) / 2 - uy * 28, my = (sy + ty) / 2 + ux * 28;
    const key = e.from + '>' + e.to, on = S.sel === key;
    const path = el('path', { class: 'edge', d: 'M' + sx + ',' + sy + ' Q' + mx + ',' + my + ' ' + tx + ',' + ty, stroke: on ? 'var(--sel)' : 'var(--edge)',
      'stroke-width': 1.5 + Math.log2(e.count) * 1.6, 'marker-end': 'url(#arrow)', 'stroke-dasharray': e.briefs === e.count ? '6 5' : '' }, E);
    el('title', {}, path).textContent = e.from + ' → ' + e.to + ': ' + e.count + ' post(s) ' + e.seqs.map((s) => '#' + s).join(' ');
    path.addEventListener('click', () => select(key));
    const t = el('text', { class: 'edge-label', x: (sx + 2 * mx + tx) / 4, y: (sy + 2 * my + ty) / 4 - 4 }, E); t.textContent = e.count;
  }
  for (const n of g.nodes) {
    const p = pos[n.name], grp = el('g', { class: 'node', transform: 'translate(' + p.x + ',' + p.y + ')' }, N), r = R(n.name);
    const c = el('circle', { r, fill: color(n), 'fill-opacity': n.state === 'killed' ? 0.35 : 0.9, stroke: S.sel === n.name ? 'var(--sel)' : color(n), 'stroke-width': S.sel === n.name ? 4 : 3 }, grp);
    if (n.state === 'working' && !D.finished) c.setAttribute('class', 'working');
    el('title', {}, grp).textContent = n.name + ' · ' + n.role + ' · ' + n.state + (n.parent ? ' · helper de ' + n.parent : '');
    const lbl = el('text', { y: r + 18 }, grp); lbl.textContent = n.name;
    const sub = el('text', { y: r + 32, style: 'fill:var(--muted);font-size:11px' }, grp); sub.textContent = n.state + ' · ' + n.posts + ' post(s)';
    const mu = modelLine(n.name);
    if (mu) { const t3 = el('text', { y: r + 46, style: 'fill:var(--muted);font-size:11px' }, grp); t3.textContent = mu; }
    grp.addEventListener('click', () => select(n.name));
  }
  feed(g);
  $('seq').max = head; $('seq').value = S.seq; $('seqLabel').textContent = '#' + S.seq + ' / #' + head;
  $('live').classList.toggle('on', S.live); $('live').textContent = D.finished ? 'Encerrado' : S.live ? '● Ao vivo' : 'Pausado';
  save();
}

function feed(g) {
  let list = D.posts.filter((p) => p.seq <= S.seq), title = 'Board';
  if (S.sel.includes('>')) { const [f, t] = S.sel.split('>'); const e = g.edges.find((x) => x.from === f && x.to === t); list = list.filter((p) => e && e.seqs.includes(p.seq)); title = f + ' → ' + t; }
  else if (S.sel) { list = list.filter((p) => p.agent === S.sel || (p.mentions || []).includes(S.sel) || (p.mentions || []).includes('all')); title = S.sel; }
  $('panelTitle').textContent = title + (S.sel ? ' (clique de novo para limpar)' : '');
  const F = $('feed'); F.textContent = '';
  for (const p of list.slice(-200).reverse()) {
    const d = document.createElement('div'); d.className = 'post';
    const m = document.createElement('div'); m.className = 'meta'; m.textContent = '#' + p.seq + ' · ' + hhmm(p.time) + (p.kind === 'brief' ? ' · brief' : '');
    const b = document.createElement('b'); b.textContent = p.agent + ': ';
    d.append(m, b, document.createTextNode(p.text)); F.appendChild(d);
  }
  if (!list.length) F.textContent = '(nada até aqui)';
}

function select(key) { S.sel = S.sel === key ? '' : key; draw(); }
let timer = null;
$('live').onclick = () => { if (D.finished) return; S.live = !S.live; if (S.live) S.seq = head; draw(); schedule(); };
$('seq').oninput = (ev) => { S.live = false; S.seq = +ev.target.value; draw(); schedule(); };
$('play').onclick = () => { S.live = false; S.seq = 0; clearInterval(timer); timer = setInterval(() => { if (S.seq >= head) { clearInterval(timer); return; } S.seq += 1; draw(); }, 450); schedule(); };
let reload = null;
function schedule() { clearTimeout(reload); if (S.live && !D.finished) reload = setTimeout(() => location.reload(), D.reloadMs); }
$('title').textContent = 'Swarm · ' + D.title; $('backend').textContent = D.backend;
$('cost').textContent = D.usage ? 'Σ ' + usd(D.usage.total.cost) + ' · ' + tok(D.usage.total.tokens.output) + ' saída' : 'sem dados de consumo';
usageTable();
$('updated').textContent = 'atualizado ' + new Date(D.generatedAt).toLocaleTimeString('pt-BR') + (D.finished ? ' · swarm encerrado' : '');
draw(); schedule();
</script>
</body>
</html>
`;
}

/** Regrava board.html (tmp+rename, para o navegador nunca ler um arquivo pela metade). Devolve a URL file:///. */
export async function writeHtml(dir, roster, posts) {
  const file = join(dir, HTML_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  let usage = null;
  try {
    usage = await collectUsage(dir, roster, process.env);
  } catch { /* consumo é informativo: sem ele o grafo continua */ }
  await fs.writeFile(tmp, renderHtml({ roster, posts, generatedAt: new Date().toISOString(), usage }), 'utf8');
  await fs.rename(tmp, file);
  return pathToFileURL(file).href;
}
