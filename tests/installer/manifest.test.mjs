import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  manifestFile,
  loadManifest,
  saveManifest,
  emptyManifest,
  getEntry,
  setEntry,
  deleteEntry,
  listEntries,
} from '../../installer/manifest.mjs';
import { makeTmp, writeTree } from './helpers.mjs';

test('manifestFile usa <home>/.swarm-agents e SWARM_AGENTS_HOME sobrescreve', () => {
  const home = join('/tmp', 'casa');
  assert.equal(manifestFile({ home, env: {} }), join(home, '.swarm-agents', 'manifest.json'));
  assert.equal(manifestFile({ home, env: { SWARM_AGENTS_HOME: join('/tmp', 'outro') } }), resolve('/tmp', 'outro', 'manifest.json'));
  assert.equal(manifestFile({ home, env: { SWARM_AGENTS_HOME: '' } }), join(home, '.swarm-agents', 'manifest.json'));
});

test('loadManifest devolve manifesto vazio quando o arquivo não existe', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  assert.deepEqual(await loadManifest(join(tmp.dir, 'm.json')), emptyManifest());
});

test('save + load preservam as entradas; set/get/delete por caminho', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const file = join(tmp.dir, 'sub', 'm.json');
  const m = emptyManifest();
  const p = join(tmp.dir, 'A.txt');
  setEntry(m, { path: p, clients: ['claude'], scope: 'user', root: tmp.dir, sha256: 'ab' });
  await saveManifest(file, m);
  const back = await loadManifest(file);
  assert.equal(getEntry(back, p).sha256, 'ab');
  assert.deepEqual(getEntry(back, p).clients, ['claude']);
  assert.equal(listEntries(back).length, 1);
  deleteEntry(back, p);
  assert.equal(getEntry(back, p), null);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).tool, 'swarm-agents');
});

test('loadManifest recusa JSON inválido sem sobrescrever (mensagem amigável)', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, { 'm.json': '{ isto não é json' });
  await assert.rejects(loadManifest(join(tmp.dir, 'm.json')), (err) => {
    assert.equal(err.code, 'MANIFESTO_INVALIDO');
    assert.match(err.message, /manifesto/i);
    return true;
  });
  assert.equal(await readFile(join(tmp.dir, 'm.json'), 'utf8'), '{ isto não é json');
});

test('loadManifest recusa estrutura inesperada', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const cases = [
    '[]',
    '{"tool":"outro","version":1,"entries":{},"dirs":[]}',
    '{"tool":"swarm-agents","version":1,"entries":[],"dirs":[]}',
    '{"tool":"swarm-agents","version":1,"entries":{"x":{"path":"relativo","clients":["a"],"scope":"user","root":"/r","sha256":"a"}},"dirs":[]}',
    '{"tool":"swarm-agents","version":1,"entries":{},"dirs":"x"}',
  ];
  for (const [i, c] of cases.entries()) {
    await writeTree(tmp.dir, { [`m${i}.json`]: c });
    await assert.rejects(loadManifest(join(tmp.dir, `m${i}.json`)), { code: 'MANIFESTO_INVALIDO' }, c);
  }
});
