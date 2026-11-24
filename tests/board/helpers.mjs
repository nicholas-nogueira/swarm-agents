// Utilitários de teste (fora da cobertura: não é código de produção).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../payload/skills/swarm/scripts/lib/cli.mjs';

export function tempDir(prefix = 'swarm-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Roda a CLI em processo e devolve { code, out, err }. */
export async function run(args, { stdin, env = {} } = {}) {
  const out = [];
  const err = [];
  const code = await main(args, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readStdin: async () => stdin ?? '',
    stdinIsTTY: stdin === undefined,
    env,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
