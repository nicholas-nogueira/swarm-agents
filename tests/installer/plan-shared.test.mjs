// Aviso de pasta compartilhada: um arquivo que o adapter A grava fica dentro de uma pasta que o adapter B
// (também selecionado) lê. O plano avisa, sem falhar e sem mudar destino nenhum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { buildPlan } from '../../installer/plan.mjs';
import { emptyManifest } from '../../installer/manifest.mjs';
import { makeTmp, fakePayload, fakeAdapter } from './helpers.mjs';

async function setup(t) {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, 'home');
  const cwd = join(tmp.dir, 'proj');
  await mkdir(home);
  await mkdir(cwd);
  const plan = (adapters, scope = 'user') => buildPlan({ home, cwd, payload: fakePayload(), manifest: emptyManifest(), adapters, scope });
  return { home, cwd, plan };
}

const paths = (plan) => plan.actions.map((a) => a.path);

test('caso feliz: cada ferramenta lê só a própria pasta, sem aviso', async (t) => {
  const { plan } = await setup(t);
  const a = fakeAdapter('codex', { reads: ({ home }) => [join(home, '.codex')] });
  const b = fakeAdapter('cursor', { reads: ({ home }) => [join(home, '.cursor')] });
  const p = await plan([a, b]);
  assert.deepEqual(p.warnings, []);
});

test('sem sobreposição: B lê outra pasta que A não usa', async (t) => {
  const { plan } = await setup(t);
  const a = fakeAdapter('codex');
  const b = fakeAdapter('cursor', { reads: ({ home }) => [join(home, '.outra')] });
  assert.deepEqual((await plan([a, b])).warnings, []);
});

test('sobreposição simples: B lê a pasta onde A grava, um aviso agrupado com contagem', async (t) => {
  const { plan, home } = await setup(t);
  const a = fakeAdapter('codex', { name: 'Codex', dirName: '.agents' });
  const b = fakeAdapter('cursor', { name: 'Cursor', reads: ({ home: h }) => [join(h, '.agents', 'skills'), join(h, '.cursor')] });
  const p = await plan([a, b]);
  const withoutReads = await plan([fakeAdapter('codex', { name: 'Codex', dirName: '.agents' }), fakeAdapter('cursor', { name: 'Cursor' })]);
  assert.deepEqual(paths(p), paths(withoutReads), 'o aviso não muda destino nenhum');
  assert.equal(p.warnings.length, 1);
  const w = p.warnings[0];
  assert.equal(w.writer, 'codex');
  assert.equal(w.reader, 'cursor');
  assert.equal(w.dir, join(home, '.agents', 'skills'));
  assert.equal(w.count, 2);
  assert.match(w.text, /Cursor também lê .*\.agents.skills e verá os arquivos adaptados para Codex/);
  assert.equal(p.counts.conflict, 0);
});

test('sobreposição A->B e B->A gera dois avisos', async (t) => {
  const { plan } = await setup(t);
  const a = fakeAdapter('codex', { reads: ({ home }) => [join(home, '.gemini')] });
  const b = fakeAdapter('gemini', { reads: ({ home }) => [join(home, '.codex')] });
  const p = await plan([a, b]);
  assert.deepEqual(
    p.warnings.map((w) => `${w.writer}->${w.reader}`).sort(),
    ['codex->gemini', 'gemini->codex'],
  );
});

test('mesmo arquivo com conteúdo idêntico gravado pelos dois: sem aviso (cada um vê o próprio conteúdo)', async (t) => {
  const { plan, home } = await setup(t);
  const reads = ({ home: h }) => [join(h, '.agents')];
  const p = await plan([fakeAdapter('codex', { dirName: '.agents', reads }), fakeAdapter('gemini', { dirName: '.agents', reads })]);
  assert.equal(p.actions.length, 3);
  assert.deepEqual(p.actions[0].clients, ['codex', 'gemini']);
  assert.deepEqual(p.warnings, []);
  assert.ok(p.actions.every((a) => a.path.startsWith(join(home, '.agents'))));
});

test('reads ausente, vazio ou cobrindo só os próprios arquivos não gera aviso', async (t) => {
  const { plan } = await setup(t);
  const own = fakeAdapter('codex', { reads: ({ home }) => [join(home, '.codex')] });
  assert.deepEqual((await plan([own, fakeAdapter('cursor', { reads: [] })])).warnings, []);
  assert.deepEqual((await plan([fakeAdapter('codex'), fakeAdapter('cursor')])).warnings, []);
});

test('escopo project: reads sob o cwd também é considerado', async (t) => {
  const { plan, cwd } = await setup(t);
  const a = fakeAdapter('codex', { dirName: '.agents' });
  const b = fakeAdapter('cursor', { reads: ({ cwd: c }) => [join(c, '.agents')] });
  const p = await plan([a, b], 'project');
  assert.equal(p.warnings.length, 1);
  assert.equal(p.warnings[0].dir, join(cwd, '.agents'));
  assert.equal(p.warnings[0].count, 3);
});

test('reads malformado (não-lista ou caminho relativo) é plano inválido', async (t) => {
  const { plan } = await setup(t);
  await assert.rejects(plan([fakeAdapter('cursor', { reads: ['relativo'] })]), { code: 'PLANO_INVALIDO' });
  await assert.rejects(plan([fakeAdapter('cursor', { reads: 'x' })]), { code: 'PLANO_INVALIDO' });
});
