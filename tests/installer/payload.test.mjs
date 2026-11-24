import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { symlink, mkdir } from 'node:fs/promises';
import { loadPayload } from '../../installer/payload.mjs';
import { InstallerError } from '../../installer/errors.mjs';
import { makeTmp, writeTree } from './helpers.mjs';

test('loadPayload lê todos os arquivos com caminho relativo em barra normal e bytes exatos', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, {
    'skills/swarm/SKILL.md': 'a\r\nb\n',
    'skills/swarm/scripts/lib/x.mjs': 'x',
    'agents/swarm-worker.md': 'w',
  });
  const payload = await loadPayload(tmp.dir);
  assert.deepEqual([...payload.keys()].sort(), [
    'agents/swarm-worker.md',
    'skills/swarm/SKILL.md',
    'skills/swarm/scripts/lib/x.mjs',
  ]);
  assert.ok(Buffer.isBuffer(payload.get('skills/swarm/SKILL.md')));
  assert.equal(payload.get('skills/swarm/SKILL.md').toString('latin1'), 'a\r\nb\n');
});

test('loadPayload recusa diretório inexistente com mensagem amigável', async () => {
  await assert.rejects(loadPayload(join('nao', 'existe', 'mesmo')), (err) => {
    assert.ok(err instanceof InstallerError);
    assert.equal(err.code, 'PAYLOAD_AUSENTE');
    assert.match(err.message, /payload/i);
    return true;
  });
});

test('loadPayload recusa payload vazio', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await assert.rejects(loadPayload(tmp.dir), { code: 'PAYLOAD_VAZIO' });
});

test('loadPayload recusa caminho que é arquivo, não diretório', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, { 'f.txt': 'x' });
  await assert.rejects(loadPayload(join(tmp.dir, 'f.txt')), { code: 'PAYLOAD_AUSENTE' });
});

test('loadPayload recusa link simbólico dentro do payload', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, { 'p/a.txt': 'a', 'fora/b.txt': 'b' });
  try {
    await symlink(join(tmp.dir, 'fora'), join(tmp.dir, 'p', 'link'), 'junction');
  } catch {
    t.skip('sem permissão para criar link nesta máquina');
    return;
  }
  await assert.rejects(loadPayload(join(tmp.dir, 'p')), { code: 'PAYLOAD_LINK' });
});

test('loadPayload ignora diretórios vazios', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, { 'a.txt': 'a' });
  await mkdir(join(tmp.dir, 'vazio'));
  const payload = await loadPayload(tmp.dir);
  assert.deepEqual([...payload.keys()], ['a.txt']);
});
