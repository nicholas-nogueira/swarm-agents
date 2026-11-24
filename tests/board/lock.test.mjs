import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { openSync, existsSync } from 'node:fs';
import { tempDir, cleanup } from './helpers.mjs';
import { withLock } from '../../payload/skills/swarm/scripts/lib/store.mjs';

const dirs = [];
after(() => dirs.forEach(cleanup));
const fresh = () => {
  const d = tempDir();
  dirs.push(d);
  return d;
};

/** Abertura que falha n vezes com o código dado e depois abre de verdade. */
function abridorQueFalha(code, n) {
  const abrir = (path, flags) => {
    abrir.chamadas++;
    if (abrir.chamadas <= n) throw Object.assign(new Error(`${code} simulado`), { code });
    return openSync(path, flags);
  };
  abrir.chamadas = 0;
  return abrir;
}

describe('withLock: contenção no Windows (EPERM/EBUSY)', () => {
  for (const code of ['EPERM', 'EBUSY']) {
    test(`${code} é tratado como contenção e repete até conseguir`, async () => {
      const dir = fresh();
      let rodou = false;
      const abrir = abridorQueFalha(code, 3);
      await withLock(dir, async () => { rodou = true; }, { open: abrir });
      assert.equal(abrir.chamadas, 4, `o abridor injetado é usado: 3 falhas ${code} e depois sucesso`);
      assert.ok(rodou);
      assert.ok(!existsSync(`${dir}/.lock`), 'o lock é solto no fim');
    });
  }

  test('EPERM persistente estoura o timeout com mensagem que cita contenção ou permissão e a pasta', async () => {
    const dir = fresh();
    await assert.rejects(
      withLock(dir, async () => {}, { timeoutMs: 80, open: abridorQueFalha('EPERM', Infinity) }),
      (e) => e.exitCode === 3 && /contenção/i.test(e.message) && /permissão/i.test(e.message) && e.message.includes(dir),
    );
  });

  test('outros erros continuam sendo lançados na hora', async () => {
    const dir = fresh();
    await assert.rejects(
      withLock(dir, async () => {}, { open: abridorQueFalha('ENOENT', 1) }),
      (e) => e.code === 'ENOENT',
    );
  });

  test('EEXIST persistente mantém a mensagem "Board ocupado"', async () => {
    const dir = fresh();
    await assert.rejects(
      withLock(dir, async () => {}, { timeoutMs: 50, open: abridorQueFalha('EEXIST', Infinity) }),
      (e) => /Board ocupado/.test(e.message),
    );
  });
});
