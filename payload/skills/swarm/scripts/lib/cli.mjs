/**
 * CLI do board do /swarm. Cada comando equivale a uma ferramenta do native swarm
 * do Antigravity: init/member (swarm add|kill|status), post (post_message),
 * read (read_board), pending (park guard / doorbell), workspace (workspace:"share").
 */
import { parseArgs } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SwarmError, COORDINATOR, ROLES, validateName, validateText, mentionsOf, concerns, unreadFor,
  pendingWakeups, unaddressedSince, numberedCopies, groupMembers, formatPost, workerPrompt,
} from './board-core.mjs';
import { resolveDir, init, transact, readRoster, readPosts, toPosix } from './store.mjs';
import { writeHtml, HTML_FILE } from './html.mjs';
import { loadModels, resolveModel, collectUsage, shortModel } from './usage.mjs';

const SCRIPT = toPosix(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'board.mjs'));

const OPTIONS = {
  dir: { type: 'string' }, session: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  title: { type: 'string' }, backend: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' },
  parent: { type: 'string' }, brief: { type: 'string' }, n: { type: 'string' }, state: { type: 'string' },
  'agent-id': { type: 'string' }, as: { type: 'string' }, text: { type: 'string' }, for: { type: 'string' },
  since: { type: 'string' }, seqs: { type: 'string' }, limit: { type: 'string' },
  'mentions-only': { type: 'boolean' }, json: { type: 'boolean' }, repo: { type: 'string' },
  force: { type: 'boolean' }, workspace: { type: 'string' }, open: { type: 'boolean' },
  tier: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
};

const HELP = `board.mjs: board compartilhado do /swarm

Uso: node board.mjs (--dir <abs> | --session <id>) <comando> [opções]

  init [--title T] [--backend subagents|teams]      cria o swarm (idempotente)
  member add --name N [--role worker|verifier] [--n K] [--parent P]
             [--workspace share --repo R] [--tier T] [--model M] [--effort E] [--brief B | stdin]
                                                    publica "@N <brief>" e imprime o prompt do worker;
                                                    o modelo/effort a passar ao Agent sai no stderr
  member update --name N [--state working|waiting|stopped] [--agent-id ID]
  member kill --name N                              encerra o membro (ou o grupo N-1..k); é permanente
  prompt --name N                                   reimprime o prompt inicial do worker
  post --as N [--text T | stdin]                    publica no board; @nome acorda, @all acorda todos
  read [--for N] [--since S] [--seqs 4,6] [--limit 20] [--mentions-only] [--json]
  pending [--json]                                  quem tem menção não lida (acordar com SendMessage)
  status [--json]                                   roster, menções pendentes e posts para ninguém
  render [--limit 30]                               board legível no terminal (/swarm board)
  workspace share --name N [--repo R]               git worktree com o estado não commitado
  workspace land --name N                           aplica os commits do autor no working copy (sem commitar)
  workspace remove --name N [--force]               remove o worktree (exige mudança integrada)
  html [--open]                                     regera o board.html (grafo ao vivo) e opcionalmente abre no navegador
  usage [--json]                                    tokens, modelo, effort e custo estimado por agente
  models                                            tiers de atividade → modelo/effort e tabela de preços
  path                                             imprime o diretório do swarm`;

const int = (v, flag, min = 0) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new SwarmError(`--${flag} precisa ser um inteiro >= ${min} (recebi "${v}").`);
  return n;
};

function member(roster, name, { allowKilled = false } = {}) {
  const m = roster.members[name];
  if (!m) throw new SwarmError(`"${name}" não existe no roster. Veja "status".`);
  if (!allowKilled && m.state === 'killed') throw new SwarmError(`"${name}" está morto (killed); adicione um worker novo.`);
  return m;
}

async function textFrom(opts, io, missing) {
  if (opts.text !== undefined) return opts.text;
  if (!io.stdinIsTTY) {
    const s = await io.readStdin();
    if (s.trim()) return s;
  }
  throw new SwarmError(missing);
}

const promptFor = (roster, dir, name) => {
  const m = roster.members[name];
  const brief = m.brief ?? '';
  return workerPrompt({
    name, role: m.role, title: roster.title, dir: toPosix(dir), script: SCRIPT, brief,
    reportTo: m.parent || COORDINATOR, workspacePath: m.workspace_path || null,
  });
};

// ---------------------------------------------------------------- git (workspace share)

function git(cwd, args, env) {
  try {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const err = new Error(String(e.stderr || e.message).trim());
    err.status = e.status;
    throw err;
  }
}

function shareWorkspace(dir, name, repoArg) {
  const repo = resolve(repoArg || process.cwd());
  let top;
  try {
    top = git(repo, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new SwarmError(`${toPosix(repo)} não é um repositório git. Sem git, os workers ficam em modo inherit, com arquivos disjuntos.`);
  }
  try {
    git(top, ['rev-parse', '--verify', '-q', 'HEAD']);
  } catch {
    throw new SwarmError('O repositório não tem commits; faça um commit antes de criar workspaces (share).');
  }
  const wtRoot = join(dir, 'wt');
  const wt = join(wtRoot, name);
  const branch = `swarm/${basename(dir).slice(0, 12)}/${name}`;
  const index = join(wtRoot, `.index-${name}`);
  mkdirSync(wtRoot, { recursive: true });
  try {
    git(top, ['worktree', 'prune']);
    const src = resolve(top, git(top, ['rev-parse', '--git-path', 'index']));
    if (existsSync(src)) copyFileSync(src, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(top, ['add', '-A'], env);
    const tree = git(top, ['write-tree'], env);
    git(top, ['worktree', 'add', '-q', '-b', branch, wt, 'HEAD']);
    git(wt, ['read-tree', '-u', '--reset', tree]);
    // O estado local do usuário vira um commit-base: o worktree começa limpo e o "land"
    // aplica só o que o autor commitar depois dele (base..branch).
    if (tree !== git(wt, ['rev-parse', 'HEAD^{tree}'])) {
      git(wt, ['-c', 'user.name=swarm', '-c', 'user.email=swarm@localhost', 'commit', '-q', '--no-verify',
        '-m', 'swarm: snapshot do working copy do coordinator (não integrar)']);
    }
  } catch (e) {
    try { git(top, ['worktree', 'remove', '--force', wt]); } catch { /* não chegou a existir */ }
    try { git(top, ['branch', '-D', branch]); } catch { /* idem */ }
    throw new SwarmError(`Falha ao criar o workspace de ${name}: ${e.message}`);
  } finally {
    rmSync(index, { force: true });
  }
  return { workspace: 'share', workspace_path: toPosix(wt), branch, repo: toPosix(top), base: git(wt, ['rev-parse', 'HEAD']) };
}

function requireWorkspace(m, name) {
  if (!m.workspace_path) throw new SwarmError(`"${name}" não tem workspace próprio.`);
}

function requireClean(m, name) {
  if (git(m.workspace_path, ['status', '--porcelain'])) {
    throw new SwarmError(`O workspace de ${name} tem mudanças não commitadas. Peça ao autor para commitar só os arquivos dele (ou use --force para descartar).`);
  }
}

/** Arquivos que o autor mudou depois do commit-base. */
const authorFiles = (m) => git(m.repo, ['diff', '--name-only', m.base, m.branch]).split('\n').filter(Boolean);

/** Integrado = branch já contido no HEAD, ou o working copy já tem exatamente o conteúdo do autor nesses arquivos. */
function isLanded(m) {
  try {
    git(m.repo, ['merge-base', '--is-ancestor', m.branch, 'HEAD']);
    return true;
  } catch {
    const files = authorFiles(m);
    if (!files.length) return true;
    try {
      git(m.repo, ['diff', '--quiet', m.branch, '--', ...files]);
      return true;
    } catch {
      return false;
    }
  }
}

/** Aplica os commits do autor (base..branch) no working copy do repositório, sem commitar. */
function landWorkspace(m, name) {
  requireWorkspace(m, name);
  requireClean(m, name);
  const files = authorFiles(m);
  if (!files.length) return [];
  try {
    git(m.repo, ['cherry-pick', '--no-commit', `${m.base}..${m.branch}`]);
  } catch (e) {
    try { git(m.repo, ['cherry-pick', '--abort']); } catch { /* nada a desfazer */ }
    throw new SwarmError(`Conflito ao integrar ${m.branch}: ${e.message.split('\n')[0]} Nada foi aplicado. Peça ao autor para ajustar (ou integre à mão).`);
  }
  return files;
}

function removeWorkspace(m, name, force) {
  requireWorkspace(m, name);
  if (!force) {
    requireClean(m, name);
    if (!isLanded(m)) {
      throw new SwarmError(`Os commits de ${m.branch} ainda não foram integrados ao repositório (rode "workspace land" ou faça merge/cherry-pick antes, ou use --force para descartar).`);
    }
  }
  git(m.repo, ['worktree', 'remove', '--force', m.workspace_path]);
  try { git(m.repo, ['branch', '-D', m.branch]); } catch { /* branch já removido */ }
}

// ---------------------------------------------------------------- comandos

const BRIEF_MISSING = 'O brief é obrigatório: um worker começa do zero e não faz nada sem ele. Use --brief ou stdin.';

async function cmdInit(dir, o, io) {
  const backend = o.backend || (io.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1' ? 'teams' : 'subagents');
  if (!['subagents', 'teams'].includes(backend)) throw new SwarmError('--backend precisa ser subagents ou teams.');
  const { created } = await init(dir, { title: o.title, backend });
  io.stdout(created
    ? `Swarm "${o.title || 'swarm'}" criado (${backend}) em ${toPosix(dir)}`
    : `Swarm já existe em ${toPosix(dir)} (nada mudou).`);
}

async function cmdMemberAdd(dir, o, io) {
  const base = validateName(o.name);
  const role = o.role || 'worker';
  if (!ROLES.includes(role)) throw new SwarmError(`--role precisa ser ${ROLES.join(' ou ')} (recebi "${role}").`);
  if (o.workspace && !['inherit', 'share'].includes(o.workspace)) throw new SwarmError('--workspace precisa ser inherit ou share.');
  const names = numberedCopies(base, int(o.n, 'n', 1) ?? 1);
  const pick = resolveModel(loadModels(), o);
  const brief = validateText(await textFrom({ text: o.brief }, io, BRIEF_MISSING));

  const roster = await transact(dir, ({ roster: r, post }) => {
    if (o.parent) {
      try {
        member(r, o.parent);
      } catch (e) {
        throw new SwarmError(`--parent: ${e.message}`);
      }
    }
    for (const n of names) {
      const old = r.members[n];
      if (old?.state === 'killed') throw new SwarmError(`"${n}" foi encerrado e não pode voltar; adicione um worker com outro nome (ex.: ${n}-2).`);
      if (old) throw new SwarmError(`O swarm já tem um membro chamado "${n}".`);
    }
    const now = new Date().toISOString();
    let last = 0;
    for (const n of names) {
      const text = `@${n} ${brief}`;
      const p = post(o.parent || COORDINATOR, text, [n], 'brief');
      r.members[n] = {
        role, state: 'working', parent: o.parent || null, workspace: 'inherit', workspace_path: null,
        agent_id: null, brief, brief_seq: p.seq, last_read_seq: 0, created_at: now,
        model: pick.model, tier: pick.tier, effort: pick.effort,
      };
      last = p.seq;
    }
    // Como no Antigravity: o worker começa com o cursor depois dos briefs de inicialização.
    for (const n of names) r.members[n].last_read_seq = last;
    return r;
  });

  if (o.workspace === 'share') {
    for (const n of names) {
      const ws = shareWorkspace(dir, n, o.repo);
      await transact(dir, ({ roster: r }) => Object.assign(r.members[n], ws));
      Object.assign(roster.members[n], ws);
    }
  }
  io.stdout(names.map((n) => (names.length > 1 ? `### Prompt para @${n}\n` : '') + promptFor(roster, dir, n)).join('\n\n'));
  const agentArgs = [pick.model !== 'inherit' && `model: "${pick.model}"`, pick.effort && `effort: "${pick.effort}"`].filter(Boolean);
  if (agentArgs.length) io.stderr(`Na ferramenta Agent, passe ${agentArgs.join(', ')}${pick.tier ? ` (tier ${pick.tier})` : ''}.`);
}

async function cmdMemberUpdate(dir, o, io) {
  if (o.state && !['working', 'waiting', 'stopped'].includes(o.state)) {
    throw new SwarmError('--state precisa ser working, waiting ou stopped (para encerrar use "member kill").');
  }
  await transact(dir, ({ roster }) => {
    const m = member(roster, o.name);
    if (o.state) m.state = o.state;
    if (o['agent-id']) m.agent_id = o['agent-id'];
  });
  io.stdout(`ok: ${o.name}${o.state ? ` → ${o.state}` : ''}${o['agent-id'] ? ` (agent ${o['agent-id']})` : ''}`);
}

async function cmdMemberKill(dir, o, io) {
  if (o.name === COORDINATOR) throw new SwarmError('O coordinator não pode ser encerrado; use "/swarm stop" para encerrar o swarm.');
  const killed = await transact(dir, ({ roster }) => {
    const names = groupMembers(o.name ?? '', roster.members);
    if (!names.length) throw new SwarmError(`"${o.name}" não existe no roster.`);
    const now = new Date().toISOString();
    for (const n of names) Object.assign(roster.members[n], { state: 'killed', killed_at: now });
    return names.map((n) => [n, roster.members[n]]);
  });
  const lines = killed.map(([n, m]) => `encerrado: ${n}${m.agent_id ? ` (pare o agente ${m.agent_id} com TaskStop se ainda estiver rodando)` : ''}`);
  for (const [n, m] of killed) {
    if (m.workspace_path && existsSync(m.workspace_path)) lines.push(`atenção: o workspace de ${n} ainda existe (${m.workspace_path}); integre e rode "workspace remove --name ${n}".`);
  }
  io.stdout(lines.join('\n'));
}

async function cmdPrompt(dir, o, io) {
  const roster = await readRoster(dir);
  member(roster, o.name, { allowKilled: true });
  io.stdout(promptFor(roster, dir, o.name));
}

async function cmdPost(dir, o, io) {
  if (!o.as) throw new SwarmError('--as <seu nome> é obrigatório.');
  const text = validateText(await textFrom(o, io, 'Sem texto: use --text ou envie o texto pelo stdin.'));
  const p = await transact(dir, ({ roster, post }) => {
    member(roster, o.as);
    const names = Object.entries(roster.members).filter(([, m]) => m.state !== 'killed').map(([n]) => n);
    const { mentions, all } = mentionsOf(text, names);
    return { ...post(o.as, text, all ? ['all'] : mentions), all };
  });
  const who = p.all ? 'todos (@all)' : p.mentions.join(', ');
  io.stdout(`#${p.seq} postado. ${who ? `Chama: ${who}` : 'Ninguém foi chamado (sem @): só será lido quando alguém acordar.'}`);
}

async function cmdRead(dir, o, io) {
  const since = int(o.since, 'since');
  const limit = int(o.limit, 'limit', 1) ?? 20;
  const roster = await readRoster(dir);
  const posts = await readPosts(dir);
  let out;
  if (o.seqs) {
    const want = new Set(o.seqs.split(',').map((s) => int(s.trim().replace(/^#/, ''), 'seqs')));
    out = posts.filter((p) => want.has(p.seq));
  } else if (o.for) {
    member(roster, o.for, { allowKilled: true });
    const names = Object.keys(roster.members);
    const cursor = since ?? roster.members[o.for].last_read_seq ?? 0;
    out = posts.filter((p) => p.seq > cursor && p.agent !== o.for);
    if (o['mentions-only']) out = out.filter((p) => concerns(p, o.for, names));
    out = out.slice(0, limit);
    if (out.length && !o['mentions-only']) {
      const upTo = out.at(-1).seq;
      await transact(dir, ({ roster: r }) => {
        r.members[o.for].last_read_seq = Math.max(r.members[o.for].last_read_seq ?? 0, upTo);
      });
    }
  } else {
    out = since !== undefined ? posts.filter((p) => p.seq > since).slice(0, limit) : posts.slice(-limit);
  }
  if (o.json) return io.stdout(JSON.stringify(out));
  const head = posts.at(-1)?.seq ?? 0;
  if (!out.length) return io.stdout(o.for ? `Nada novo para @${o.for} (head = ${head}).` : `Nenhum post (head = ${head}).`);
  io.stdout(`${out.map(formatPost).join('\n')}\n(${out.length} post(s); head = ${head})`);
}

async function snapshot(dir) {
  const roster = await readRoster(dir);
  const posts = await readPosts(dir);
  const coord = roster.members[COORDINATOR];
  return {
    roster,
    posts,
    pending: pendingWakeups(roster.members, posts),
    unaddressed: unaddressedSince(roster.members, posts, coord?.last_read_seq ?? 0),
  };
}

const pendingLines = (pending) => pending.map((p) => `acordar @${p.name} (${p.state}${p.agent_id ? `, agent ${p.agent_id}` : ''}): menções não lidas ${p.seqs.map((s) => `#${s}`).join(' ')}`);

async function cmdPending(dir, o, io) {
  const { pending } = await snapshot(dir);
  if (o.json) return io.stdout(JSON.stringify(pending));
  io.stdout(pending.length ? pendingLines(pending).join('\n') : 'Ninguém para acordar: todas as menções foram lidas.');
}

function rosterLines(roster, posts) {
  return Object.entries(roster.members).map(([n, m]) => {
    const unread = m.state === 'killed' ? 0 : unreadFor(n, roster.members, posts).mentions.length;
    const ws = m.workspace_path ? ` · ws ${m.branch}` : '';
    const parent = m.parent ? ` · helper de @${m.parent}` : '';
    return `  ${n.padEnd(14)} ${m.role.padEnd(11)} ${m.state.padEnd(8)} leu até #${m.last_read_seq ?? 0}${unread ? ` · ${unread} menção(ões) não lida(s)` : ''}${parent}${ws}`;
  });
}

async function cmdStatus(dir, o, io) {
  const { roster, posts, pending, unaddressed } = await snapshot(dir);
  const head = posts.at(-1)?.seq ?? 0;
  if (o.json) return io.stdout(JSON.stringify({ title: roster.title, backend: roster.backend, head, members: roster.members, pending, unaddressed }));
  const lines = [`Swarm "${roster.title}" (${roster.backend}) · head #${head} · ${toPosix(dir)}`, ...rosterLines(roster, posts)];
  if (pending.length) lines.push('', ...pendingLines(pending));
  for (const p of unaddressed) lines.push(`#${p.seq} de ${p.agent} foi para ninguém (sem @) e o coordinator ainda não leu.`);
  const workers = Object.entries(roster.members).filter(([n, m]) => n !== COORDINATOR && m.state !== 'killed');
  if (workers.length && workers.every(([, m]) => m.state !== 'working')) {
    lines.push('', pending.length
      ? 'Travado? Ninguém está working: acorde os membros acima com SendMessage.'
      : 'Ninguém está working e não há menção pendente: o swarm espera por você (coordinator).');
  }
  lines.push('', graphLine(dir));
  io.stdout(lines.join('\n'));
}

const graphLine = (dir) => `Grafo ao vivo: ${pathToFileURL(join(dir, HTML_FILE)).href}  (abrir: html --open)`;

/** Abre a URL no navegador padrão, sem shell do usuário e sem segurar o processo. */
function openInBrowser(url, env) {
  if (env.SWARM_NO_OPEN === '1') return false;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return true;
}

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const fmtUsd = (c, unpriced) => (c === null ? 'sem preço' : `US$ ${c.toFixed(4)}${unpriced ? '+' : ''}`);

async function cmdUsage(dir, o, io) {
  const roster = await readRoster(dir);
  const u = await collectUsage(dir, roster, io.env);
  if (o.json) return io.stdout(JSON.stringify(u));
  const lines = ['Agente         Modelo(s)               Effort   Entrada  Cache(l/e)      Saída   Custo (estimativa)'];
  for (const [name, m] of Object.entries(u.members)) {
    const t = m.tokens;
    lines.push([
      name.padEnd(14), m.models.map(shortModel).join(',').padEnd(23), String(m.lastEffort || '-').padEnd(8),
      fmtTok(t.input).padStart(7), `${fmtTok(t.cacheRead)}/${fmtTok(t.cacheWrite5m + t.cacheWrite1h)}`.padStart(15),
      fmtTok(t.output).padStart(7), `  ${fmtUsd(m.cost, m.unpriced)}`,
    ].join(' '));
  }
  const missing = Object.keys(roster.members).filter((n) => !u.members[n] && roster.members[n].state !== 'killed');
  if (missing.length) lines.push(`Sem dados ainda: ${missing.join(', ')} (sem agent_id ou transcrição não encontrada).`);
  lines.push(`Total do swarm: ${fmtUsd(u.total.cost, u.total.unpriced)} · saída ${fmtTok(u.total.tokens.output)} · cache lido ${fmtTok(u.total.tokens.cacheRead)}`);
  lines.push('Custo estimado pelo models.json; o valor real é o do seu plano.');
  io.stdout(lines.join('\n'));
}

async function cmdModels(dir, o, io) {
  const m = loadModels();
  const lines = ['Tier           Modelo   Effort   Quando usar'];
  for (const [t, v] of Object.entries(m.tiers)) lines.push(`${t.padEnd(14)} ${v.model.padEnd(8)} ${v.effort.padEnd(8)} ${v.uso}`);
  lines.push('', 'Preços (US$ / 1M tokens): entrada · saída · cache lido · cache escrito 5 min');
  for (const [alias, id] of Object.entries(m.aliases)) {
    const p = m.prices[id];
    lines.push(`${alias.padEnd(7)} ${id.padEnd(18)} ${p.input} · ${p.output} · ${p.cache_read} · ${p.cache_write_5m}`);
  }
  io.stdout(lines.join('\n'));
}

async function cmdHtml(dir, o, io) {
  const url = await writeHtml(dir, await readRoster(dir), await readPosts(dir));
  io.stdout(url);
  if (o.open) io.stdout(openInBrowser(url, io.env) ? 'Abrindo o grafo no navegador (atualiza sozinho a cada 3 s).' : 'Navegador não aberto (SWARM_NO_OPEN=1); abra a URL acima.');
}

async function cmdRender(dir, o, io) {
  const roster = await readRoster(dir);
  const posts = await readPosts(dir);
  const limit = int(o.limit, 'limit', 1) ?? 30;
  const live = Object.values(roster.members).filter((m) => m.state !== 'killed').length;
  const shown = posts.slice(-limit);
  io.stdout([
    `══ Swarm: ${roster.title} (${roster.backend}) · ${live} membro(s) vivo(s) · head #${posts.at(-1)?.seq ?? 0} ══`,
    ...rosterLines(roster, posts),
    `── Board${posts.length > shown.length ? ` (últimos ${shown.length} de ${posts.length})` : ''} ──`,
    ...(shown.length ? shown.map(formatPost) : ['(vazio)']),
    '',
    graphLine(dir),
  ].join('\n'));
}

async function cmdWorkspaceShare(dir, o, io) {
  const roster = await readRoster(dir);
  const m = member(roster, validateName(o.name));
  if (m.workspace_path) throw new SwarmError(`"${o.name}" já tem workspace em ${m.workspace_path}.`);
  const ws = shareWorkspace(dir, o.name, o.repo);
  await transact(dir, ({ roster: r }) => Object.assign(r.members[o.name], ws));
  io.stdout(`Workspace de ${o.name}: ${ws.workspace_path} (branch ${ws.branch}, com o estado não commitado de ${ws.repo}).`);
}

async function cmdWorkspaceLand(dir, o, io) {
  const roster = await readRoster(dir);
  const m = member(roster, o.name, { allowKilled: true });
  const files = landWorkspace(m, o.name);
  io.stdout(files.length
    ? `Integrado no working copy de ${m.repo} (sem commit; revise com git diff): ${files.join(', ')}`
    : `Nada para integrar: ${o.name} ainda não commitou nada depois do commit-base.`);
}

async function cmdWorkspaceRemove(dir, o, io) {
  const roster = await readRoster(dir);
  const m = member(roster, o.name, { allowKilled: true });
  removeWorkspace(m, o.name, o.force);
  await transact(dir, ({ roster: r }) => Object.assign(r.members[o.name], { workspace: 'inherit', workspace_path: null, removed_branch: m.branch }));
  io.stdout(`Workspace de ${o.name} removido (${m.workspace_path}; branch ${m.branch} apagado).`);
}

const COMMANDS = {
  init: cmdInit,
  'member add': cmdMemberAdd,
  'member update': cmdMemberUpdate,
  'member kill': cmdMemberKill,
  prompt: cmdPrompt,
  post: cmdPost,
  read: cmdRead,
  pending: cmdPending,
  status: cmdStatus,
  render: cmdRender,
  'workspace share': cmdWorkspaceShare,
  'workspace land': cmdWorkspaceLand,
  'workspace remove': cmdWorkspaceRemove,
  html: cmdHtml,
  usage: cmdUsage,
  models: cmdModels,
  path: async (dir, o, io) => io.stdout(toPosix(dir)),
};

export async function main(argv, io) {
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw new SwarmError(`${e.message} Use --help.`);
    }
    const { values: o, positionals: [cmd, sub] } = parsed;
    if (o.help || !cmd) {
      io.stdout(HELP);
      return o.help ? 0 : 2;
    }
    const handler = COMMANDS[sub ? `${cmd} ${sub}` : cmd];
    if (!handler) throw new SwarmError(`Comando desconhecido "${[cmd, sub].filter(Boolean).join(' ')}". Use --help.`);
    const dir = resolveDir(o, io.env);
    await handler(dir, o, io);
    return 0;
  } catch (e) {
    if (e instanceof SwarmError) {
      io.stderr(`swarm: ${e.message}`);
      return e.exitCode;
    }
    io.stderr(`swarm: erro inesperado: ${e.message}`);
    return 1;
  }
}

