// Utilitários dos testes e2e: roda bin/swarm-agents.mjs num processo filho com HOME, USERPROFILE e cwd
// temporários e um ambiente mínimo (nenhuma variável das ferramentas reais vaza para o teste).
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, readdir, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const BIN = join(REPO, 'bin', 'swarm-agents.mjs');
export const GOLDEN = join(REPO, 'tests', 'golden', 'baseline-claude.sha256');

const PASS_THROUGH = ['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT', 'NODE_V8_COVERAGE'];

export async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sa-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const cwd = join(dir, 'proj');
  await mkdir(home);
  await mkdir(cwd);
  // Trava de segurança: nunca rodar contra o HOME real.
  if (resolve(home).toLowerCase() === resolve(homedir()).toLowerCase()) throw new Error('HOME temporário igual ao real');
  const env = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.HOME = home;
  env.USERPROFILE = home;
  const run = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', input: '' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, home, cwd, env, run };
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Lista recursiva de arquivos: Map relPath(barra normal) -> sha256. */
export async function tree(root) {
  const out = new Map();
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.set(relative(root, p).split('\\').join('/'), sha256(await readFile(p)));
    }
  };
  await walk(root);
  return out;
}

/** Linha de base: Map relPath -> sha256, só arquivos de runtime (sem skills/swarm/tests/). */
export async function baselineRuntime() {
  const map = new Map();
  for (const line of (await readFile(GOLDEN, 'utf8')).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) \*?(.+)$/.exec(line.trim());
    if (m && !m[2].startsWith('skills/swarm/tests/')) map.set(m[2], m[1]);
  }
  return map;
}

export async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}
