// Utilitários dos testes do instalador: diretórios temporários, payload falso e adapters falsos
// que seguem o contrato de adapters/index.mjs (id, name, defaultSelected, verified, notes, detect, plan).
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

export async function makeTmp(prefix = 'sa-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Cria a árvore { 'a/b.txt': 'conteúdo' } dentro de root. */
export async function writeTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const file = join(root, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

export function fakePayload(extra = {}) {
  const map = new Map();
  const base = {
    'skills/swarm/SKILL.md': '---\nname: swarm\n---\ncorpo\n',
    'skills/swarm/scripts/board.mjs': 'console.log("board")\n',
    'agents/swarm-worker.md': '---\nname: swarm-worker\n---\nworker\n',
    ...extra,
  };
  for (const [k, v] of Object.entries(base)) map.set(k, Buffer.from(v));
  return map;
}

/**
 * Adapter falso: grava cada arquivo do payload em <raiz>/.<id>/<relPath>.
 * opts.transform(relPath, buf) permite mudar o conteúdo; opts.files substitui o plano inteiro.
 */
export function fakeAdapter(id, opts = {}) {
  const {
    name = `Ferramenta ${id}`,
    defaultSelected = true,
    detected = true,
    verified = 'doc',
    notes = [],
    planNotes = [],
    transform = (_rel, buf) => buf,
    files,
    dirName = `.${id}`,
    reads,
  } = opts;
  const readsFor = (ctx) => (typeof reads === 'function' ? reads(ctx) : reads);
  return {
    id,
    name,
    defaultSelected,
    verified,
    notes,
    detect: typeof detected === 'function' ? detected : () => detected,
    plan({ scope, home, cwd, payload }) {
      const extra = reads === undefined ? {} : { reads: readsFor({ scope, home, cwd }) };
      if (files) return { files: files({ scope, home, cwd, payload }), notes: planNotes, ...extra };
      const base = join(scope === 'user' ? home : cwd, dirName);
      const out = [];
      for (const [rel, buf] of payload) out.push({ path: join(base, ...rel.split('/')), content: transform(rel, buf) });
      return { files: out, notes: planNotes, ...extra };
    },
  };
}

/** Stream de saída que acumula o texto escrito. */
export function captureStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  stream.text = () => chunks.join('');
  return stream;
}

/** Entrada simulada: cada item vira uma linha digitada; `end` fecha a entrada (EOF). */
export function inputFrom(lines, { end = true } = {}) {
  const stream = new PassThrough();
  for (const l of lines) stream.write(`${l}\n`);
  if (end) stream.end();
  return stream;
}
