// Testes do próprio payload: layout esperado, nada fora dele, frontmatter coerente.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = (...partes) => join(RAIZ, 'payload', ...partes);

const ESPERADOS = [
  'skills/swarm/SKILL.md',
  'skills/swarm/models.json',
  'skills/swarm/references/backends.md',
  'skills/swarm/scripts/board.mjs',
  'skills/swarm/scripts/lib/board-core.mjs',
  'skills/swarm/scripts/lib/cli.mjs',
  'skills/swarm/scripts/lib/html.mjs',
  'skills/swarm/scripts/lib/store.mjs',
  'skills/swarm/scripts/lib/usage.mjs',
  'agents/swarm-worker.md',
  'agents/swarm-verifier.md',
];

function frontmatter(texto) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  assert.ok(m, 'frontmatter ausente');
  return Object.fromEntries(
    m[1].split(/\r?\n/).filter((l) => /^[\w-]+:/.test(l)).map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i), l.slice(i + 1).trim()];
    }),
  );
}

describe('payload: layout', () => {
  test('arquivos de runtime esperados estão presentes', () => {
    for (const rel of ESPERADOS) assert.ok(existsSync(P(rel)), `faltando: ${rel}`);
  });

  test('só existem as pastas skills/ e agents/ na raiz do payload', () => {
    assert.deepEqual(readdirSync(P()).sort(), ['agents', 'skills']);
  });

  test('a skill não carrega testes nem dependências', () => {
    assert.ok(!existsSync(P('skills', 'swarm', 'tests')));
    assert.ok(!existsSync(P('skills', 'swarm', 'node_modules')));
  });
});

describe('payload: conteúdo', () => {
  test('SKILL.md declara name swarm e descrição', () => {
    const fm = frontmatter(readFileSync(P('skills/swarm/SKILL.md'), 'utf8'));
    assert.equal(fm.name, 'swarm');
    assert.ok(fm.description.length > 10);
  });

  test('agentes declaram o próprio nome', () => {
    for (const nome of ['swarm-worker', 'swarm-verifier']) {
      assert.equal(frontmatter(readFileSync(P('agents', `${nome}.md`), 'utf8')).name, nome);
    }
  });

  test('o verifier não pode editar arquivos', () => {
    const fm = frontmatter(readFileSync(P('agents/swarm-verifier.md'), 'utf8'));
    assert.match(fm.disallowedTools, /Edit/);
    assert.match(fm.disallowedTools, /Write/);
  });

  test('models.json é JSON válido', () => {
    assert.doesNotThrow(() => JSON.parse(readFileSync(P('skills/swarm/models.json'), 'utf8')));
  });

  test('cenário negativo: nenhum arquivo do payload contém segredo conhecido', () => {
    const rx = /PLAYWRIGHT_MCP_EXTENSION_TOKEN|sk-[A-Za-z0-9]{20,}/;
    for (const rel of ESPERADOS) assert.ok(!rx.test(readFileSync(P(rel), 'utf8')), rel);
  });
});
