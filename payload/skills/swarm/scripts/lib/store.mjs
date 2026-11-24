/**
 * Armazenamento do board em arquivos (equivalente ao filestore do Antigravity):
 *   <dir>/board.jsonl   feed só de append, um post por linha
 *   <dir>/members.json  roster com estado e cursor de leitura de cada membro
 * Escritas acontecem sob um lock de arquivo (retry com backoff exponencial),
 * e o roster é gravado via tmp+rename para nunca ficar pela metade.
 */
import { promises as fs, openSync, closeSync, writeSync, statSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { SwarmError, COORDINATOR } from './board-core.mjs';
import { writeHtml } from './html.mjs';

const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const STALE_MS = 30_000;

export const toPosix = (p) => p.replaceAll('\\', '/');

export function swarmHome(env = process.env) {
  return env.SWARM_HOME || join(homedir(), '.claude', 'swarm');
}

/** Diretório do swarm a partir de --dir (absoluto), --session (validado) ou SWARM_DIR. */
export function resolveDir({ dir, session }, env = process.env) {
  if (dir) {
    if (!isAbsolute(dir)) throw new SwarmError(`--dir precisa ser um caminho absoluto (recebi "${dir}").`);
    return resolve(dir);
  }
  if (session) {
    if (!SESSION_RE.test(session)) throw new SwarmError(`--session inválido "${session}": use só letras, dígitos, - e _.`);
    return join(swarmHome(env), session);
  }
  if (env.SWARM_DIR && isAbsolute(env.SWARM_DIR)) return resolve(env.SWARM_DIR);
  throw new SwarmError('Informe o swarm com --dir <caminho absoluto> ou --session <id>.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Executa fn com lock exclusivo do diretório; retry com backoff exponencial e lock velho expirado. */
export async function withLock(dir, fn, { timeoutMs = 10_000, open = openSync } = {}) {
  const lock = join(dir, '.lock');
  const deadline = Date.now() + timeoutMs;
  let delay = 5;
  let sawWinContention = false;
  for (;;) {
    try {
      const fd = open(lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      // No Windows, sob colisão, a abertura exclusiva pode falhar com EPERM/EBUSY em vez de EEXIST.
      const winContention = e.code === 'EPERM' || e.code === 'EBUSY';
      if (e.code !== 'EEXIST' && !winContention) throw e;
      if (winContention) sawWinContention = true;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { force: true });
      } catch { /* o dono acabou de soltar */ }
      if (Date.now() > deadline && sawWinContention) {
        throw new SwarmError(`Não consegui o lock em ${timeoutMs} ms (${lock}): pode ser contenção com outro processo OU falta de permissão na pasta do swarm (${dir}).`, 3);
      }
      if (Date.now() > deadline) throw new SwarmError(`Board ocupado: não consegui o lock em ${timeoutMs} ms (${lock}).`, 3);
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 200);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

const boardFile = (dir) => join(dir, 'board.jsonl');
const membersFile = (dir) => join(dir, 'members.json');

export async function exists(dir) {
  try {
    await fs.access(membersFile(dir));
    return true;
  } catch {
    return false;
  }
}

async function requireSwarm(dir) {
  if (!(await exists(dir))) throw new SwarmError(`Nenhum swarm em ${toPosix(dir)}. Rode "init" primeiro.`);
}

/** Lê o feed; linhas corrompidas são ignoradas (o board nunca trava por uma linha ruim). */
export async function readPosts(dir) {
  let raw = '';
  try {
    raw = await fs.readFile(boardFile(dir), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const posts = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      if (Number.isInteger(p.seq)) posts.push(p);
    } catch { /* linha corrompida: ignora */ }
  }
  return posts;
}

export async function readRoster(dir) {
  await requireSwarm(dir);
  return JSON.parse(await fs.readFile(membersFile(dir), 'utf8'));
}

async function writeRoster(dir, roster) {
  const tmp = `${membersFile(dir)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(roster, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, membersFile(dir));
}

/** Cria o swarm se ainda não existir (idempotente). Devolve { created }. */
export async function init(dir, { title, backend }) {
  await fs.mkdir(dir, { recursive: true });
  return withLock(dir, async () => {
    if (await exists(dir)) return { created: false };
    const now = new Date().toISOString();
    await writeRoster(dir, {
      title: title || 'swarm',
      backend: backend || 'subagents',
      created_at: now,
      members: { [COORDINATOR]: { role: COORDINATOR, state: 'working', last_read_seq: 0, created_at: now } },
    });
    await fs.writeFile(boardFile(dir), '', { flag: 'a' });
    await refreshHtml(dir, await readRoster(dir), []);
    return { created: true };
  });
}

/** Regera o board.html; o grafo é conveniência, então uma falha nele nunca derruba a escrita no board. */
async function refreshHtml(dir, roster, posts) {
  try {
    await writeHtml(dir, roster, posts);
  } catch (e) {
    process.emitWarning(`swarm: não consegui atualizar o board.html (${e.message})`);
  }
}

/**
 * Transação sob lock: fn(state) recebe { roster, posts, post(agent, text, mentions) }
 * e pode mudar o roster; o roster é salvo ao final e os posts são anexados em ordem.
 */
export async function transact(dir, fn) {
  await requireSwarm(dir);
  return withLock(dir, async () => {
    const roster = await readRoster(dir);
    const posts = await readPosts(dir);
    let head = posts.reduce((max, p) => Math.max(max, p.seq), 0);
    const added = [];
    const post = (agent, text, mentions, kind) => {
      const p = { seq: ++head, agent, text, time: new Date().toISOString(), mentions, ...(kind ? { kind } : {}) };
      added.push(p);
      posts.push(p);
      return p;
    };
    const result = await fn({ roster, posts, post });
    if (added.length) await fs.appendFile(boardFile(dir), added.map((p) => `${JSON.stringify(p)}\n`).join(''), 'utf8');
    await writeRoster(dir, roster);
    await refreshHtml(dir, roster, posts);
    return result;
  });
}
