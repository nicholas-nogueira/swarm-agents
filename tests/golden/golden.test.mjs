// Golden: o payload tem de ser byte-idêntico à linha de base do Claude Code (Regra 1).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAYLOAD = join(RAIZ, 'payload');
const BASELINE = join(dirname(fileURLToPath(import.meta.url)), 'baseline-claude.sha256');

/** Lê linhas "<sha256> *<caminho>" e ignora os testes da skill (não são runtime). */
export function lerBaseline(texto) {
  const mapa = new Map();
  for (const linha of texto.split(/\r?\n/)) {
    if (!linha.trim()) continue;
    const m = /^([0-9a-f]{64}) [* ](.+)$/.exec(linha);
    if (!m) throw new Error(`Linha inválida na linha de base: ${linha}`);
    if (m[2].includes('/tests/')) continue;
    mapa.set(m[2], m[1]);
  }
  return mapa;
}

function listar(dir) {
  const out = [];
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) out.push(...listar(p));
    else out.push(relative(PAYLOAD, p).split(sep).join('/'));
  }
  return out.sort();
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

describe('golden: payload x linha de base do Claude', () => {
  const base = lerBaseline(readFileSync(BASELINE, 'utf8'));

  test('a linha de base tem os 13 arquivos de runtime', () => {
    assert.equal(base.size, 13);
  });

  test('cada arquivo da linha de base existe no payload com o mesmo sha256', () => {
    for (const [rel, esperado] of base) {
      assert.equal(sha(readFileSync(join(PAYLOAD, rel))), esperado, `divergiu: ${rel}`);
    }
  });

  test('o payload não tem arquivo fora da linha de base', () => {
    assert.deepEqual(listar(PAYLOAD), [...base.keys()].sort());
  });

  test('cenário negativo: um byte alterado muda o hash', () => {
    const [rel, esperado] = [...base][0];
    const buf = Buffer.from(readFileSync(join(PAYLOAD, rel)));
    buf[0] ^= 1;
    assert.notEqual(sha(buf), esperado);
  });

  test('cenário negativo: linha de base malformada é recusada', () => {
    assert.throws(() => lerBaseline('lixo sem hash'), /Linha inválida/);
  });
});
