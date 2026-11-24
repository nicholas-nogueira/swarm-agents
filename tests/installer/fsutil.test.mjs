import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFile, symlink, mkdir, stat, readdir } from 'node:fs/promises';
import {
  sha256,
  toBuffer,
  pathKey,
  isInside,
  inspectPath,
  assertSafeTarget,
  atomicWrite,
  missingAncestors,
  removeEmptyDirs,
} from '../../installer/fsutil.mjs';
import { makeTmp, writeTree } from './helpers.mjs';

test('sha256 e toBuffer', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(toBuffer('á').equals(Buffer.from('á', 'utf8')));
  const b = Buffer.from([1, 2]);
  assert.equal(toBuffer(b), b);
  assert.throws(() => toBuffer(42), { code: 'CONTEUDO_INVALIDO' });
});

test('isInside: só caminhos estritamente dentro da raiz', () => {
  const root = join('/tmp', 'raiz');
  assert.equal(isInside(root, join(root, 'a', 'b')), true);
  assert.equal(isInside(root, root), false);
  assert.equal(isInside(root, join(root, '..', 'fora')), false);
  assert.equal(isInside(root, join('/tmp', 'raizX', 'a')), false);
});

test('pathKey normaliza o caminho (minúsculas no Windows)', () => {
  const k = pathKey(join('/tmp', 'A', '..', 'B', 'c.txt'));
  const expected = resolve('/tmp', 'B', 'c.txt');
  assert.equal(k, process.platform === 'win32' ? expected.toLowerCase() : expected);
});

test('inspectPath distingue ausente, arquivo e diretório', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, { 'f.txt': 'oi' });
  assert.deepEqual(await inspectPath(join(tmp.dir, 'nada')), { exists: false, kind: null, bytes: null });
  const f = await inspectPath(join(tmp.dir, 'f.txt'));
  assert.equal(f.kind, 'file');
  assert.equal(f.bytes.toString(), 'oi');
  assert.equal((await inspectPath(tmp.dir)).kind, 'dir');
});

test('assertSafeTarget aceita destino dentro da raiz e recusa fora dela', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await assertSafeTarget(tmp.dir, join(tmp.dir, 'a', 'b.txt'));
  await assert.rejects(assertSafeTarget(tmp.dir, join(tmp.dir, '..', 'fora.txt')), { code: 'DESTINO_FORA_DA_RAIZ' });
  await assert.rejects(assertSafeTarget(tmp.dir, 'relativo.txt'), { code: 'DESTINO_INVALIDO' });
});

test('assertSafeTarget recusa link que aponta para fora da raiz', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const root = join(tmp.dir, 'raiz');
  await mkdir(root);
  await mkdir(join(tmp.dir, 'fora'));
  try {
    await symlink(join(tmp.dir, 'fora'), join(root, 'link'), 'junction');
  } catch {
    t.skip('sem permissão para criar link nesta máquina');
    return;
  }
  await assert.rejects(assertSafeTarget(root, join(root, 'link', 'x.txt')), { code: 'DESTINO_LINK' });
});

test('assertSafeTarget recusa destino que é ele mesmo um link', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await mkdir(join(tmp.dir, 'alvo'));
  try {
    await symlink(join(tmp.dir, 'alvo'), join(tmp.dir, 'eu'), 'junction');
  } catch {
    t.skip('sem permissão para criar link nesta máquina');
    return;
  }
  await assert.rejects(assertSafeTarget(tmp.dir, join(tmp.dir, 'eu')), { code: 'DESTINO_LINK' });
});

test('missingAncestors lista os diretórios que faltam, do mais raso ao mais fundo', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const file = join(tmp.dir, 'a', 'b', 'c.txt');
  assert.deepEqual(await missingAncestors(file), [join(tmp.dir, 'a'), join(tmp.dir, 'a', 'b')]);
});

test('atomicWrite cria diretórios, grava os bytes e não deixa temporário', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const file = join(tmp.dir, 'x', 'y.txt');
  const created = await atomicWrite(file, Buffer.from('um'));
  assert.deepEqual(created, [join(tmp.dir, 'x')]);
  assert.equal(await readFile(file, 'utf8'), 'um');
  await atomicWrite(file, Buffer.from('dois'));
  assert.equal(await readFile(file, 'utf8'), 'dois');
  assert.deepEqual(await readdir(join(tmp.dir, 'x')), ['y.txt']);
});

test('atomicWrite falha de forma limpa quando o pai é um arquivo', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, { bloqueio: 'sou arquivo' });
  await assert.rejects(atomicWrite(join(tmp.dir, 'bloqueio', 'f.txt'), Buffer.from('x')));
});

test('removeEmptyDirs apaga só diretórios vazios, do mais fundo ao mais raso', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await mkdir(join(tmp.dir, 'a', 'b'), { recursive: true });
  await writeTree(tmp.dir, { 'c/keep.txt': 'x' });
  await mkdir(join(tmp.dir, 'c', 'd'));
  const removed = await removeEmptyDirs([join(tmp.dir, 'a'), join(tmp.dir, 'a', 'b'), join(tmp.dir, 'c'), join(tmp.dir, 'c', 'd'), join(tmp.dir, 'nao-existe')]);
  assert.deepEqual(removed.sort(), [join(tmp.dir, 'a'), join(tmp.dir, 'a', 'b'), join(tmp.dir, 'c', 'd')].sort());
  assert.ok((await stat(join(tmp.dir, 'c'))).isDirectory());
});
