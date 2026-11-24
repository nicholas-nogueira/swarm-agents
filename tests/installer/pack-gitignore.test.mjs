import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { prepararPacote, limparPacote } from '../../scripts/pack-gitignore.mjs';
import { makeTmp, writeTree } from './helpers.mjs';

const REL = 'skills/swarm';

test('prepararPacote cria dot-gitignore idêntico ao .gitignore; limparPacote remove só a cópia', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, { [`${REL}/.gitignore`]: 'tmp/\r\nx\n' });
  assert.equal(await prepararPacote(tmp.dir, REL), true);
  assert.equal((await readFile(join(tmp.dir, REL, 'dot-gitignore'))).toString('latin1'), 'tmp/\r\nx\n');
  assert.equal(await limparPacote(tmp.dir, REL), true);
  await assert.rejects(access(join(tmp.dir, REL, 'dot-gitignore')));
  assert.equal((await readFile(join(tmp.dir, REL, '.gitignore'))).toString(), 'tmp/\r\nx\n');
});

test('prepararPacote falha com mensagem clara se o .gitignore do payload não existe', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await assert.rejects(prepararPacote(tmp.dir, REL), /\.gitignore/);
});

test('limparPacote é idempotente: sem a cópia, não faz nada e não falha', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  assert.equal(await limparPacote(tmp.dir, REL), false);
});
