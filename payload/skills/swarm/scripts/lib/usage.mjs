/**
 * Consumo de tokens, modelo e effort de cada agente do swarm.
 *
 * Fonte: as transcrições que o próprio Claude Code grava em
 *   ~/.claude/projects/<projeto>/<sessão>.jsonl                          (coordinator)
 *   ~/.claude/projects/<projeto>/<sessão>/subagents/agent-<id>.jsonl     (cada subagente)
 * Cada resposta do modelo traz message.{id, model, usage} e o effort usado. A mesma mensagem
 * aparece em várias linhas (uma por bloco de conteúdo) com o mesmo usage, por isso a soma é feita
 * por message.id. A leitura é incremental (usage-cache.json guarda o offset de cada arquivo),
 * para que regerar o board.html a cada post continue barato mesmo com transcrições grandes.
 */
import { promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SwarmError, COORDINATOR } from './board-core.mjs';

const MODELS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'models.json');
const CACHE_FILE = 'usage-cache.json';

let modelsCache = null;
/** Tabela de preços, aliases e tiers (models.json na raiz da skill, editável pelo usuário). */
export function loadModels() {
  modelsCache ??= JSON.parse(readFileSync(MODELS_FILE, 'utf8'));
  return modelsCache;
}

export const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, fastInput: 0, fastOutput: 0, messages: 0 });

export function addTo(acc, t) {
  for (const k of Object.keys(acc)) acc[k] += t[k] || 0;
  return acc;
}

export const shortModel = (id) => String(id).replace(/^claude-/, '');

export function priceOf(models, id) {
  const p = models.prices[id];
  if (!p) return null;
  const { input, output, cache_write_5m, cache_write_1h, cache_read, fast_multiplier } = p;
  return { input, output, cache_write_5m, cache_write_1h, cache_read, fast_multiplier };
}

/** Custo estimado em US$; null quando o modelo não está na tabela (nunca inventa preço). */
export function costOf(models, id, t) {
  const p = priceOf(models, id);
  if (!p) return null;
  const fm = p.fast_multiplier ?? 1;
  const micro = (t.input - t.fastInput) * p.input + t.fastInput * p.input * fm
    + (t.output - t.fastOutput) * p.output + t.fastOutput * p.output * fm
    + t.cacheRead * p.cache_read + t.cacheWrite5m * p.cache_write_5m + t.cacheWrite1h * p.cache_write_1h;
  return micro / 1e6;
}

/**
 * Soma o usage de um trecho de transcrição. `since` descarta mensagens anteriores (ISO);
 * `lastId` é o id da última mensagem já contada (dedupe na fronteira da leitura incremental).
 */
export function parseUsage(text, { since = null, lastId = null } = {}) {
  const out = { messages: 0, byModel: {}, efforts: {}, lastEffort: null, lastId };
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      continue;
    }
    const m = r?.message;
    if (!m?.usage || !m.model || m.model === '<synthetic>') continue;
    if (m.id && m.id === out.lastId) continue;
    out.lastId = m.id ?? null;
    if (since && r.timestamp && r.timestamp < since) continue;
    const u = m.usage;
    const t = (out.byModel[m.model] ??= emptyTotals());
    const cw = u.cache_creation_input_tokens || 0;
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.cacheWrite1h += cw1h;
    t.cacheWrite5m += cw - cw1h;
    if (u.speed === 'fast') {
      t.fastInput += u.input_tokens || 0;
      t.fastOutput += u.output_tokens || 0;
    }
    t.messages += 1;
    out.messages += 1;
    if (r.effort) {
      out.efforts[r.effort] = (out.efforts[r.effort] || 0) + 1;
      out.lastEffort = r.effort;
    }
  }
  return out;
}

/** Modelo e effort de um membro novo: --model/--effort explícitos vencem o tier; sem nada, herda. */
export function resolveModel(models, { tier, model, effort } = {}) {
  const tiers = Object.keys(models.tiers);
  if (tier && !models.tiers[tier]) throw new SwarmError(`--tier precisa ser ${tiers.join(', ')} (recebi "${tier}"). Veja "models".`);
  const names = [...Object.keys(models.aliases), 'inherit'];
  if (model && !names.includes(model)) throw new SwarmError(`--model precisa ser ${names.join(', ')} (recebi "${model}").`);
  if (effort && !models.efforts.includes(effort)) throw new SwarmError(`--effort precisa ser ${models.efforts.join(', ')} (recebi "${effort}").`);
  const t = tier ? models.tiers[tier] : {};
  return { tier: tier || null, model: model || t.model || 'inherit', effort: effort || t.effort || null };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Projetos que têm transcrição desta sessão. */
async function projectDirs(projectsDir, session) {
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(projectsDir, e.name);
    try {
      await fs.access(join(p, `${session}.jsonl`));
      found.push(p);
    } catch { /* outra sessão */ }
  }
  return found;
}

function mergeInto(acc, part) {
  acc.messages += part.messages;
  for (const [id, t] of Object.entries(part.byModel)) addTo((acc.byModel[id] ??= emptyTotals()), t);
  for (const [e, n] of Object.entries(part.efforts)) acc.efforts[e] = (acc.efforts[e] || 0) + n;
  if (part.lastEffort) acc.lastEffort = part.lastEffort;
  acc.lastId = part.lastId;
}

/** Lê só o que foi anexado desde a última vez (até a última quebra de linha completa). */
async function readIncremental(file, entry, since) {
  let size;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return null;
  }
  let e = entry && entry.since === since && entry.offset <= size ? entry
    : { since, offset: 0, messages: 0, byModel: {}, efforts: {}, lastEffort: null, lastId: null };
  if (size > e.offset) {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(size - e.offset);
      await fh.read(buf, 0, buf.length, e.offset);
      const end = buf.lastIndexOf(0x0a);
      if (end >= 0) {
        e = { ...e };
        mergeInto(e, parseUsage(buf.subarray(0, end + 1).toString('utf8'), { since, lastId: e.lastId }));
        e.offset += end + 1;
      }
    } finally {
      await fh.close();
    }
  }
  return e;
}

/**
 * Consumo por membro, por modelo e total do swarm. Só entra quem tem transcrição encontrada
 * (o coordinator a partir do init; workers pelo agent_id). Nunca lança: sem dados devolve vazio.
 */
export async function collectUsage(dir, roster, env = process.env) {
  const models = loadModels();
  const projectsDir = env.SWARM_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
  const session = basename(dir);
  const result = { members: {}, byModel: {}, total: { tokens: emptyTotals(), cost: 0, unpriced: false }, source: models._fonte };
  const projects = await projectDirs(projectsDir, session);
  if (!projects.length) return result;

  const cachePath = join(dir, CACHE_FILE);
  const cache = (await readJson(cachePath)) || {};
  cache.files ??= {};

  const files = { [COORDINATOR]: { since: roster.created_at || null, paths: projects.map((p) => join(p, `${session}.jsonl`)) } };
  for (const [name, m] of Object.entries(roster.members || {})) {
    if (name !== COORDINATOR && m.agent_id) {
      files[name] = { since: null, paths: projects.map((p) => join(p, session, 'subagents', `agent-${m.agent_id}.jsonl`)) };
    }
  }

  for (const [name, { since, paths }] of Object.entries(files)) {
    const acc = { messages: 0, byModel: {}, efforts: {}, lastEffort: null, lastId: null };
    for (const p of paths) {
      const e = await readIncremental(p, cache.files[p], since);
      if (!e) continue;
      cache.files[p] = e;
      mergeInto(acc, e);
    }
    if (!acc.messages) continue;
    const tokens = emptyTotals();
    let cost = 0;
    let unpriced = false;
    for (const [id, t] of Object.entries(acc.byModel)) {
      addTo(tokens, t);
      const c = costOf(models, id, t);
      if (c === null) unpriced = true;
      else cost += c;
      const bm = (result.byModel[id] ??= { tokens: emptyTotals(), cost: costOf(models, id, emptyTotals()) });
      addTo(bm.tokens, t);
      bm.cost = costOf(models, id, bm.tokens);
    }
    const m = roster.members[name] || {};
    result.members[name] = {
      models: Object.keys(acc.byModel), tokens, cost, unpriced, efforts: acc.efforts, lastEffort: acc.lastEffort,
      declared: { model: m.model || null, tier: m.tier || null, effort: m.effort || null },
    };
    addTo(result.total.tokens, tokens);
    result.total.cost += cost;
    result.total.unpriced ||= unpriced;
  }

  try {
    await fs.writeFile(cachePath, JSON.stringify(cache), 'utf8');
  } catch { /* cache é otimização: sem ele, a próxima leitura recomeça do zero */ }
  return result;
}
