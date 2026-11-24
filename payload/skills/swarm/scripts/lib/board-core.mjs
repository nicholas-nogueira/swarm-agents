/**
 * Lógica pura do board do /swarm (sem I/O).
 *
 * Espelha as regras do native swarm do Antigravity (pacote Go `nativeswarm/board`,
 * recuperado do agy.exe com o REA): nomes de membro, menções, cursores de leitura
 * e quem precisa ser acordado.
 */

export const MAX_TEXT = 16_000;
export const MAX_NAME = 24;
export const ROLES = ['worker', 'verifier'];
export const STATES = ['working', 'waiting', 'stopped', 'killed'];
export const COORDINATOR = 'coordinator';

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_RUNE = /[\p{L}\p{Nd}_-]/u;

/** Erro de uso: a CLI mostra a mensagem como está e sai com código 2. */
export class SwarmError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'SwarmError';
    this.exitCode = exitCode;
  }
}

export function validateName(name) {
  if (typeof name !== 'string' || name === '') throw new SwarmError('--name é obrigatório.');
  if (name === 'all' || name === COORDINATOR || name.startsWith(`${COORDINATOR}-`)) {
    throw new SwarmError(`"${name}" é reservado (all = broadcast, coordinator = você).`);
  }
  if (name.length > MAX_NAME) {
    throw new SwarmError(`O nome "${name}" passa de ${MAX_NAME} caracteres; dê ao worker o nome da função dele (ex.: parser, verifier).`);
  }
  if (!NAME_RE.test(name)) {
    throw new SwarmError(`Nome inválido "${name}": use minúsculas, começando por letra ou dígito, só a-z, 0-9, - e _.`);
  }
  return name;
}

export function validateText(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) throw new SwarmError('O texto do post é obrigatório.');
  if (t.length > MAX_TEXT) {
    throw new SwarmError(`Post longo demais (${t.length} > ${MAX_TEXT} caracteres). Salve o detalhe num arquivo e poste o caminho.`);
  }
  return t;
}

// "@" em início de palavra, seguido do nome e de um caractere que não é de nome (ou fim).
function namedToken(lower, name) {
  for (let i = lower.indexOf('@'); i >= 0; i = lower.indexOf('@', i + 1)) {
    if (i > 0 && NAME_RUNE.test([...lower.slice(Math.max(0, i - 2), i)].pop())) continue;
    if (!lower.startsWith(name, i + 1)) continue;
    const j = i + 1 + name.length;
    if (j >= lower.length || !NAME_RUNE.test(String.fromCodePoint(lower.codePointAt(j)))) return true;
  }
  return false;
}

function named(lower, name) {
  if (namedToken(lower, name)) return true;
  const m = name.match(/^(.+)-\d+$/); // @fix chama fix-1..fix-k
  return m ? namedToken(lower, m[1]) : false;
}

/** Quem o texto chama pelo nome (ou prefixo de grupo) e se usa @all. */
export function mentionsOf(text, names) {
  const lower = String(text ?? '').toLowerCase();
  return {
    mentions: (names ?? []).filter((n) => named(lower, String(n).toLowerCase())),
    all: named(lower, 'all'),
  };
}

/** Se o post chama este membro (menção direta, de grupo ou @all). Nunca o próprio post. */
export function concerns(post, name, names) {
  if (post.agent === name) return false;
  // Um brief chama só o próprio dono; os @ dentro dele são instruções ("poste @verifier"), não campainhas.
  if (post.kind === 'brief') return (post.mentions ?? []).includes(name);
  const { mentions, all } = mentionsOf(post.text, names);
  return all || mentions.includes(name);
}

const live = (m) => m && m.state !== 'killed';

/** Posts que o membro ainda não leu (pulando os dele) e, entre eles, os que o chamam. */
export function unreadFor(name, members, posts) {
  const names = Object.keys(members);
  const cursor = members[name]?.last_read_seq ?? 0;
  const all = posts.filter((p) => p.seq > cursor && p.agent !== name);
  return { all, mentions: all.filter((p) => concerns(p, name, names)) };
}

/** Equivalente ao park guard do Antigravity: membros vivos com menção não lida. */
export function pendingWakeups(members, posts) {
  return Object.entries(members)
    .filter(([, m]) => live(m))
    .map(([name, m]) => ({ name, state: m.state, agent_id: m.agent_id ?? null, seqs: unreadFor(name, members, posts).mentions.map((p) => p.seq) }))
    .filter((p) => p.seqs.length > 0);
}

/** Posts depois de `since` que não chamam ninguém: o "resultado que foi para ninguém" do monitor. */
export function unaddressedSince(members, posts, since) {
  const names = Object.keys(members);
  return posts.filter((p) => {
    if (p.seq <= since || p.agent === COORDINATOR) return false;
    const { mentions, all } = mentionsOf(p.text, names);
    return !all && mentions.length === 0;
  });
}

export function numberedCopies(base, n) {
  if (!Number.isInteger(n) || n < 1) throw new SwarmError('--n precisa ser um inteiro maior ou igual a 1.');
  const names = n === 1 ? [base] : Array.from({ length: n }, (_, i) => `${base}-${i + 1}`);
  names.forEach(validateName);
  return names;
}

/** O membro com esse nome exato ou, se não houver, o grupo numerado nome-1..k. */
export function groupMembers(name, members) {
  if (members[name]) return [name];
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`);
  return Object.keys(members).filter((n) => re.test(n));
}

/**
 * Grafo de comunicação (aba Graph do Antigravity): nós = membros, arestas = autor → mencionado,
 * com contagem e #seqs. `upTo` limita ao replay até aquele seq.
 * Autocontida de propósito: a página board.html embute esta mesma função (toString).
 */
export function buildGraph(members, posts, upTo = Infinity) {
  const names = Object.keys(members || {});
  const sent = {};
  const edges = new Map();
  for (const p of posts || []) {
    if (p.seq > upTo) continue;
    sent[p.agent] = (sent[p.agent] || 0) + 1;
    const raw = p.mentions || [];
    const targets = raw.includes('all')
      ? names.filter((n) => n !== p.agent && members[n].state !== 'killed')
      : raw.filter((n) => n !== p.agent && names.includes(n));
    for (const to of targets) {
      const key = `${p.agent}→${to}`;
      const e = edges.get(key) || { from: p.agent, to, count: 0, briefs: 0, seqs: [] };
      e.count += 1;
      if (p.kind === 'brief') e.briefs += 1;
      e.seqs.push(p.seq);
      edges.set(key, e);
    }
  }
  return {
    nodes: names.map((n) => ({ name: n, role: members[n].role, state: members[n].state, parent: members[n].parent || null, posts: sent[n] || 0 })),
    edges: [...edges.values()],
  };
}

const pad = (n) => String(n).padStart(2, '0');

export function formatPost(p) {
  const d = new Date(p.time);
  const hhmm = Number.isNaN(d.getTime()) ? '--:--' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `#${p.seq} [${hhmm}] ${p.agent}: ${p.text}`;
}

/** Primeira mensagem de um worker: tarefa + como falar com o board (o protocolo está no agente swarm-worker/verifier). */
export function workerPrompt({ name, role, title, dir, script, brief, reportTo, workspacePath }) {
  const cmd = `node "${script}" --dir "${dir}"`;
  const where = workspacePath
    ? `Seu workspace próprio (git worktree) é ${workspacePath}. Trabalhe só nele, com caminhos absolutos (prefixe comandos com cd "${workspacePath}" &&), e commite sua mudança nele antes do [done].`
    : 'Você trabalha no mesmo diretório do coordinator. Mexa só nos arquivos que são seus.';
  return [
    `Você acabou de começar. Sua tarefa (@${name}, papel ${role}, swarm "${title}"):`,
    '',
    brief,
    '',
    '--- Board do swarm ---',
    `Ler o que é novo:  ${cmd} read --for ${name}`,
    `Ler posts citados: ${cmd} read --seqs 4,6`,
    `Postar:            ${cmd} post --as ${name} --text "@quem texto"   (texto longo: via stdin/heredoc, sem --text)`,
    `Roster:            ${cmd} status`,
    where,
    `Reporte a @${reportTo}. Termine a entrega final com um post "@${reportTo} [done] <resultado>" e encerre o turno com um resumo de uma linha citando o #seq.`,
  ].join('\n');
}
