import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { buildPlan } from '../../installer/plan.mjs';
import { applyPlan } from '../../installer/apply.mjs';
import { emptyManifest, loadManifest, getEntry } from '../../installer/manifest.mjs';
import { sha256 } from '../../installer/fsutil.mjs';
import { EXIT } from '../../installer/errors.mjs';
import { makeTmp, writeTree, fakePayload, fakeAdapter } from './helpers.mjs';

async function setup(t) {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, 'home');
  const cwd = join(tmp.dir, 'proj');
  await mkdir(home);
  await mkdir(cwd);
  const mfile = join(home, '.swarm-agents', 'manifest.json');
  return { home, cwd, payload: fakePayload(), mfile };
}

const exists = (p) => access(p).then(() => true, () => false);

test('aplica o plano, grava bytes exatos e registra o manifesto com dirs criados', async (t) => {
  const ctx = await setup(t);
  const manifest = emptyManifest();
  const plan = await buildPlan({ ...ctx, manifest, adapters: [fakeAdapter('claude')], scope: 'user' });
  const res = await applyPlan(plan, { manifest, manifestFile: ctx.mfile });
  assert.deepEqual(res.results.map((r) => r.status), ['created', 'created', 'created']);
  const skill = join(ctx.home, '.claude', 'skills', 'swarm', 'SKILL.md');
  assert.ok((await readFile(skill)).equals(ctx.payload.get('skills/swarm/SKILL.md')));
  const saved = await loadManifest(ctx.mfile);
  const e = getEntry(saved, skill);
  assert.equal(e.sha256, sha256(ctx.payload.get('skills/swarm/SKILL.md')));
  assert.deepEqual(e.clients, ['claude']);
  assert.equal(e.scope, 'user');
  assert.ok(saved.dirs.includes(join(ctx.home, '.claude')));
});

test('reaplicar é idempotente: tudo unchanged, nenhum arquivo reescrito', async (t) => {
  const ctx = await setup(t);
  let manifest = emptyManifest();
  await applyPlan(await buildPlan({ ...ctx, manifest, adapters: [fakeAdapter('claude')], scope: 'user' }), { manifest, manifestFile: ctx.mfile });
  manifest = await loadManifest(ctx.mfile);
  const plan2 = await buildPlan({ ...ctx, manifest, adapters: [fakeAdapter('claude')], scope: 'user' });
  assert.deepEqual(plan2.counts, { create: 0, update: 0, unchanged: 3, conflict: 0 });
  const res = await applyPlan(plan2, { manifest, manifestFile: ctx.mfile });
  assert.ok(res.results.every((r) => r.status === 'unchanged'));
});

test('update de arquivo nosso faz backup e troca o conteúdo', async (t) => {
  const ctx = await setup(t);
  let manifest = emptyManifest();
  await applyPlan(await buildPlan({ ...ctx, manifest, adapters: [fakeAdapter('claude')], scope: 'user' }), { manifest, manifestFile: ctx.mfile });
  manifest = await loadManifest(ctx.mfile);
  const v2 = fakeAdapter('claude', { transform: (rel, buf) => (rel.endsWith('SKILL.md') ? Buffer.from('v2') : buf) });
  const plan = await buildPlan({ ...ctx, manifest, adapters: [v2], scope: 'user' });
  const res = await applyPlan(plan, { manifest, manifestFile: ctx.mfile });
  const skill = join(ctx.home, '.claude', 'skills', 'swarm', 'SKILL.md');
  assert.equal(await readFile(skill, 'utf8'), 'v2');
  assert.ok((await readFile(`${skill}.swarm-agents.bak`)).equals(ctx.payload.get('skills/swarm/SKILL.md')));
  assert.deepEqual(res.backups, [`${skill}.swarm-agents.bak`]);
});

test('conflito sem force: applyPlan recusa com código 2 e não escreve nada', async (t) => {
  const ctx = await setup(t);
  await writeTree(ctx.home, { '.claude/agents/swarm-worker.md': 'do usuário' });
  const manifest = emptyManifest();
  const plan = await buildPlan({ ...ctx, manifest, adapters: [fakeAdapter('claude')], scope: 'user' });
  await assert.rejects(applyPlan(plan, { manifest, manifestFile: ctx.mfile }), (err) => {
    assert.equal(err.exitCode, EXIT.CONFLICT);
    assert.equal(err.code, 'CONFLITO');
    return true;
  });
  assert.equal(await exists(join(ctx.home, '.claude', 'skills')), false);
  assert.equal(await exists(ctx.mfile), false);
});

test('force: sobrescreve arquivo alheio guardando backup', async (t) => {
  const ctx = await setup(t);
  await writeTree(ctx.home, { '.claude/agents/swarm-worker.md': 'do usuário' });
  const manifest = emptyManifest();
  const plan = await buildPlan({ ...ctx, manifest, adapters: [fakeAdapter('claude')], scope: 'user', force: true });
  await applyPlan(plan, { manifest, manifestFile: ctx.mfile });
  const worker = join(ctx.home, '.claude', 'agents', 'swarm-worker.md');
  assert.equal(await readFile(`${worker}.swarm-agents.bak`, 'utf8'), 'do usuário');
  assert.ok((await readFile(worker)).equals(ctx.payload.get('agents/swarm-worker.md')));
});

test('alvo mudou entre o plano e a aplicação: rollback completo', async (t) => {
  const ctx = await setup(t);
  const manifest = emptyManifest();
  const plan = await buildPlan({ ...ctx, manifest, adapters: [fakeAdapter('claude')], scope: 'user' });
  // O último arquivo do plano aparece depois do plano (corrida): a transação precisa desfazer os anteriores.
  const last = plan.actions.at(-1).path;
  await writeTree(ctx.home, { [last.slice(ctx.home.length + 1)]: 'surgiu agora' });
  await assert.rejects(applyPlan(plan, { manifest, manifestFile: ctx.mfile }), { code: 'ALVO_MUDOU' });
  assert.equal(await readFile(last, 'utf8'), 'surgiu agora');
  for (const a of plan.actions.slice(0, -1)) assert.equal(await exists(a.path), false, a.path);
  assert.equal(await exists(join(ctx.home, '.claude', 'skills')), false);
  assert.equal(await exists(ctx.mfile), false);
});

test('falha no readback restaura o original e apaga o backup criado', async (t) => {
  const ctx = await setup(t);
  await writeTree(ctx.home, { '.claude/agents/swarm-worker.md': 'do usuário' });
  const manifest = emptyManifest();
  const plan = await buildPlan({ ...ctx, manifest, adapters: [fakeAdapter('claude')], scope: 'user', force: true });
  const worker = join(ctx.home, '.claude', 'agents', 'swarm-worker.md');
  const io = {
    readFile: async (p) => (p === worker ? Buffer.from('corrompido') : readFile(p)),
  };
  await assert.rejects(applyPlan(plan, { manifest, manifestFile: ctx.mfile, io }), (err) => {
    assert.equal(err.code, 'FALHA_NA_ESCRITA');
    assert.match(err.message, /desfeit/);
    return true;
  });
  assert.equal(await readFile(worker, 'utf8'), 'do usuário');
  assert.equal(await exists(`${worker}.swarm-agents.bak`), false);
  assert.deepEqual(await readdir(join(ctx.home, '.claude')), ['agents']);
});

test('falha ao salvar o manifesto desfaz a instalação', async (t) => {
  const ctx = await setup(t);
  const manifest = emptyManifest();
  const plan = await buildPlan({ ...ctx, manifest, adapters: [fakeAdapter('claude')], scope: 'user' });
  // O manifesto não consegue ser gravado: o pai dele é um arquivo.
  await writeFile(join(ctx.home, 'bloqueio'), 'x');
  const mfile = join(ctx.home, 'bloqueio', 'manifest.json');
  await assert.rejects(applyPlan(plan, { manifest, manifestFile: mfile }), { code: 'FALHA_NA_ESCRITA' });
  assert.equal(await exists(join(ctx.home, '.claude')), false);
});

test('falha no meio de uma escrita (pai virou arquivo) desfaz o que já foi escrito', async (t) => {
  const ctx = await setup(t);
  const manifest = emptyManifest();
  const adapter = fakeAdapter('claude', {
    files: ({ home }) => [
      { path: join(home, '.claude', 'a.txt'), content: 'a' },
      { path: join(home, '.claude', 'b', 'c.txt'), content: 'c' },
    ],
  });
  const plan = await buildPlan({ ...ctx, manifest, adapters: [adapter], scope: 'user' });
  const io = {
    beforeWrite: async (p) => {
      if (p.endsWith('c.txt')) await writeFile(join(ctx.home, '.claude', 'b'), 'virei arquivo');
    },
  };
  await assert.rejects(applyPlan(plan, { manifest, manifestFile: ctx.mfile, io }), { code: 'FALHA_NA_ESCRITA' });
  assert.equal(await exists(join(ctx.home, '.claude', 'a.txt')), false);
});

test('result traz unchanged para ações que não precisam de escrita, e as notas não interferem', async (t) => {
  const ctx = await setup(t);
  await writeTree(join(ctx.home, '.claude'), { 'skills/swarm/SKILL.md': ctx.payload.get('skills/swarm/SKILL.md') });
  const manifest = emptyManifest();
  const plan = await buildPlan({ ...ctx, manifest, adapters: [fakeAdapter('claude', { planNotes: ['n'] })], scope: 'user' });
  const res = await applyPlan(plan, { manifest, manifestFile: ctx.mfile });
  assert.equal(res.results.find((r) => r.path.endsWith('SKILL.md')).status, 'unchanged');
  // arquivo pré-existente igual passa a ser registrado como nosso
  assert.ok(getEntry(await loadManifest(ctx.mfile), join(ctx.home, '.claude', 'skills', 'swarm', 'SKILL.md')));
});
