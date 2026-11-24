// Utilitários dos testes dos adapters: payload falso (com as construções do Claude que os adapters trocam),
// payload real do repositório, diretórios temporários e verificação de frontmatter.
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const AQUI = dirname(fileURLToPath(import.meta.url));
export const RAIZ = resolve(AQUI, '..', '..');
export const PAYLOAD_REAL = join(RAIZ, 'payload');

export async function makeTmp(prefix = 'sa-adapters-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Cria a árvore { 'a/b.txt': 'conteúdo' } dentro de root. */
export async function writeTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const file = join(root, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

export const MOCK_SKILL = [
  '---',
  'name: swarm',
  'description: (Preview) Roda um swarm com @menções, #seq e [done]. Inspirado no /swarm do Google Antigravity. Use só quando o usuário pedir /swarm, um "swarm" ou "enxame".',
  'argument-hint: "<tarefa> | board | stop"',
  'shell: bash',
  '---',
  '',
  '# Você é o coordenador do swarm',
  '',
  'Entrada do usuário: `$ARGUMENTS`',
  '',
  'Board desta sessão (o comando que você usa em toda chamada do board; copie como está):',
  '',
  '```',
  'BOARD = node "${CLAUDE_SKILL_DIR}/scripts/board.mjs" --session ${CLAUDE_SESSION_ID}',
  '```',
  '',
  'Estado atual:',
  '!`node "${CLAUDE_SKILL_DIR}/scripts/board.mjs" --session ${CLAUDE_SESSION_ID} status 2>&1 || echo "(nenhum swarm)"`',
  '',
  'Motor: !`[ "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-0}" = "1" ] && echo "teams" || echo "subagents"`',
  '',
  '- Se `swarm-worker` não estiver disponível, comece o prompt com: "leia ~/.claude/agents/swarm-worker.md (ou swarm-verifier.md)."',
  '- Contexto quente: "Leia e siga ~/.claude/agents/swarm-worker.md."',
  '',
].join('\n');

export const MOCK_WORKER = [
  '---',
  'name: swarm-worker',
  'description: Worker de um /swarm. Uso exclusivo do coordenador. Não use fora de um swarm.',
  'model: inherit',
  'color: yellow',
  '---',
  '',
  '# Você é um worker de um swarm',
  '',
  'Corpo do worker com `read --for <você>`.',
  '',
].join('\n');

export const MOCK_VERIFIER = [
  '---',
  'name: swarm-verifier',
  'description: Verifier de um /swarm. Confere o trabalho dos workers e devolve problemas ao autor.',
  'model: inherit',
  'color: cyan',
  'disallowedTools: Edit, Write, NotebookEdit',
  '---',
  '',
  '# Você é um verifier de um swarm',
  '',
  'Corpo do verifier. Você não corrige.',
  '',
].join('\n');

/** Payload falso mínimo, com a mesma forma que installer/payload.mjs devolve (Map relPath -> Buffer). */
export function mockPayload(overrides = {}) {
  const base = {
    'skills/swarm/SKILL.md': MOCK_SKILL,
    'skills/swarm/models.json': '{"tiers":{}}\n',
    'skills/swarm/package.json': '{"name":"claude-swarm"}\n',
    'skills/swarm/references/backends.md': '# backends\n',
    'skills/swarm/scripts/board.mjs': 'console.log("board");\n',
    'skills/swarm/scripts/lib/cli.mjs': 'export const x = 1;\n',
    'agents/swarm-worker.md': MOCK_WORKER,
    'agents/swarm-verifier.md': MOCK_VERIFIER,
    ...overrides,
  };
  const map = new Map();
  for (const [k, v] of Object.entries(base)) if (v !== null) map.set(k, Buffer.from(v));
  return map;
}

async function walk(dir, base = dir, acc = new Map()) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, acc);
    else acc.set(full.slice(base.length + 1).replaceAll('\\', '/'), await readFile(full));
  }
  return acc;
}

export const temPayloadReal = () => existsSync(join(PAYLOAD_REAL, 'skills', 'swarm', 'SKILL.md'));

/** Payload real do repositório (payload/), no mesmo formato do loadPayload do instalador. */
export const realPayload = () => walk(PAYLOAD_REAL);

/** Contexto padrão de plan() para os testes, com diretórios fictícios absolutos. */
export function ctxFor(base, scope = 'user', payload = mockPayload()) {
  return { scope, home: join(base, 'home'), cwd: join(base, 'projeto'), payload };
}

const norm = (p) => p.replaceAll('\\', '/');

/** Procura um arquivo planejado pelo sufixo do caminho (separadores normalizados). */
export function findFile(plan, suffix) {
  const f = plan.files.find((x) => norm(x.path).endsWith(suffix));
  if (!f) throw new Error(`arquivo planejado não encontrado: ${suffix}\nplanejados:\n${plan.files.map((x) => norm(x.path)).join('\n')}`);
  return f;
}

export const textOfFile = (f) => (Buffer.isBuffer(f.content) ? f.content.toString('utf8') : f.content);
export const posix = norm;
