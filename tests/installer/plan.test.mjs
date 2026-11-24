import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, symlink } from 'node:fs/promises';
import { buildPlan } from '../../installer/plan.mjs';
import { emptyManifest, setEntry } from '../../installer/manifest.mjs';
import { sha256 } from '../../installer/fsutil.mjs';
import { makeTmp, writeTree, fakePayload, fakeAdapter } from './helpers.mjs';

async function setup(t) {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, 'home');
  const cwd = join(tmp.dir, 'proj');
  await mkdir(home);
  await mkdir(cwd);
  return { home, cwd, payload: fakePayload(), manifest: emptyManifest() };
}

const ops = (plan) => plan.actions.map((a) => a.op);

test('escopo user: tudo vira create sob o home, com notas do adapter', async (t) => {
  const ctx = await setup(t);
  const plan = await buildPlan({ ...ctx, adapters: [fakeAdapter('claude', { planNotes: ['nota x'] })], scope: 'user' });
  assert.equal(plan.root, ctx.home);
  assert.deepEqual(ops(plan), ['create', 'create', 'create']);
  assert.ok(plan.actions.every((a) => a.path.startsWith(join(ctx.home, '.claude'))));
  assert.ok(plan.actions.every((a) => a.backupPath === null && a.currentSha === null));
  assert.deepEqual(plan.notes, [{ client: 'claude', text: 'nota x' }]);
  assert.deepEqual(plan.counts, { create: 3, update: 0, unchanged: 0, conflict: 0 });
});

test('escopo project: destinos sob o cwd', async (t) => {
  const ctx = await setup(t);
  const plan = await buildPlan({ ...ctx, adapters: [fakeAdapter('codex')], scope: 'project' });
  assert.equal(plan.root, ctx.cwd);
  assert.ok(plan.actions.every((a) => a.path.startsWith(ctx.cwd)));
});

test('arquivo igual byte a byte vira unchanged, mesmo sem manifesto', async (t) => {
  const ctx = await setup(t);
  await writeTree(join(ctx.home, '.claude'), { 'skills/swarm/SKILL.md': ctx.payload.get('skills/swarm/SKILL.md') });
  const plan = await buildPlan({ ...ctx, adapters: [fakeAdapter('claude')], scope: 'user' });
  const a = plan.actions.find((x) => x.path.endsWith('SKILL.md'));
  assert.equal(a.op, 'unchanged');
});

test('arquivo nosso (registrado e intacto) que mudou no payload vira update com backup', async (t) => {
  const ctx = await setup(t);
  const target = join(ctx.home, '.claude', 'agents', 'swarm-worker.md');
  await writeTree(ctx.home, { '.claude/agents/swarm-worker.md': 'versão antiga' });
  setEntry(ctx.manifest, { path: target, clients: ['claude'], scope: 'user', root: ctx.home, sha256: sha256(Buffer.from('versão antiga')) });
  const plan = await buildPlan({ ...ctx, adapters: [fakeAdapter('claude')], scope: 'user' });
  const a = plan.actions.find((x) => x.path === target);
  assert.equal(a.op, 'update');
  assert.equal(a.reason, 'nosso');
  assert.equal(a.backupPath, `${target}.swarm-agents.bak`);
  assert.equal(a.currentSha, sha256(Buffer.from('versão antiga')));
});

test('arquivo alheio e diferente vira conflict; com force vira update com backup', async (t) => {
  const ctx = await setup(t);
  await writeTree(ctx.home, { '.claude/agents/swarm-worker.md': 'do usuário' });
  const plan = await buildPlan({ ...ctx, adapters: [fakeAdapter('claude')], scope: 'user' });
  assert.equal(plan.counts.conflict, 1);
  const c = plan.actions.find((x) => x.op === 'conflict');
  assert.equal(c.reason, 'alheio');
  const forced = await buildPlan({ ...ctx, adapters: [fakeAdapter('claude')], scope: 'user', force: true });
  const f = forced.actions.find((x) => x.path === c.path);
  assert.equal(f.op, 'update');
  assert.equal(f.reason, 'force');
  assert.ok(f.backupPath.endsWith('.swarm-agents.bak'));
});

test('arquivo registrado mas modificado pelo usuário vira conflict', async (t) => {
  const ctx = await setup(t);
  const target = join(ctx.home, '.claude', 'agents', 'swarm-worker.md');
  await writeTree(ctx.home, { '.claude/agents/swarm-worker.md': 'editado' });
  setEntry(ctx.manifest, { path: target, clients: ['claude'], scope: 'user', root: ctx.home, sha256: sha256(Buffer.from('original')) });
  const plan = await buildPlan({ ...ctx, adapters: [fakeAdapter('claude')], scope: 'user' });
  assert.equal(plan.actions.find((x) => x.path === target).op, 'conflict');
});

test('backup já existente com outro conteúdo não é sobrescrito: usa nome com hash', async (t) => {
  const ctx = await setup(t);
  await writeTree(ctx.home, {
    '.claude/agents/swarm-worker.md': 'do usuário',
    '.claude/agents/swarm-worker.md.swarm-agents.bak': 'backup antigo',
  });
  const plan = await buildPlan({ ...ctx, adapters: [fakeAdapter('claude')], scope: 'user', force: true });
  const a = plan.actions.find((x) => x.op === 'update');
  assert.match(a.backupPath, /\.swarm-agents\.bak\.[0-9a-f]{12}$/);
});

test('backup existente com o mesmo conteúdo é reaproveitado', async (t) => {
  const ctx = await setup(t);
  await writeTree(ctx.home, {
    '.claude/agents/swarm-worker.md': 'do usuário',
    '.claude/agents/swarm-worker.md.swarm-agents.bak': 'do usuário',
  });
  const plan = await buildPlan({ ...ctx, adapters: [fakeAdapter('claude')], scope: 'user', force: true });
  const a = plan.actions.find((x) => x.op === 'update');
  assert.ok(a.backupPath.endsWith('.swarm-agents.bak'));
  assert.equal(a.backupExists, true);
});

test('destino que é diretório é conflito que nem o force resolve', async (t) => {
  const ctx = await setup(t);
  await mkdir(join(ctx.home, '.claude', 'agents', 'swarm-worker.md'), { recursive: true });
  const plan = await buildPlan({ ...ctx, adapters: [fakeAdapter('claude')], scope: 'user', force: true });
  const c = plan.actions.find((x) => x.op === 'conflict');
  assert.equal(c.reason, 'nao-e-arquivo');
});

test('mesmo destino com mesmo conteúdo vindo de 2 adapters vira uma ação com 2 clientes', async (t) => {
  const ctx = await setup(t);
  const plan = await buildPlan({
    ...ctx,
    adapters: [fakeAdapter('codex', { dirName: '.agents' }), fakeAdapter('gemini', { dirName: '.agents' })],
    scope: 'user',
  });
  assert.equal(plan.actions.length, 3);
  assert.deepEqual(plan.actions[0].clients, ['codex', 'gemini']);
});

test('mesmo destino com conteúdos diferentes entre adapters é erro amigável', async (t) => {
  const ctx = await setup(t);
  await assert.rejects(
    buildPlan({
      ...ctx,
      adapters: [fakeAdapter('codex', { dirName: '.agents' }), fakeAdapter('gemini', { dirName: '.agents', transform: () => Buffer.from('outro') })],
      scope: 'user',
    }),
    (err) => {
      assert.equal(err.code, 'DESTINO_DUPLICADO');
      assert.match(err.message, /codex/);
      assert.match(err.message, /gemini/);
      return true;
    },
  );
});

test('adapter que planeja fora da raiz do escopo é recusado (path traversal)', async (t) => {
  const ctx = await setup(t);
  const evil = fakeAdapter('codex', { files: ({ home }) => [{ path: join(home, '..', 'fora.txt'), content: 'x' }] });
  await assert.rejects(buildPlan({ ...ctx, adapters: [evil], scope: 'user' }), { code: 'DESTINO_FORA_DA_RAIZ' });
});

test('adapter com caminho relativo ou plano malformado é recusado', async (t) => {
  const ctx = await setup(t);
  const rel = fakeAdapter('codex', { files: () => [{ path: 'relativo.txt', content: 'x' }] });
  await assert.rejects(buildPlan({ ...ctx, adapters: [rel], scope: 'user' }), { code: 'DESTINO_INVALIDO' });
  const bad = { ...fakeAdapter('codex'), plan: () => ({ nada: true }) };
  await assert.rejects(buildPlan({ ...ctx, adapters: [bad], scope: 'user' }), { code: 'PLANO_INVALIDO' });
  const badContent = fakeAdapter('codex', { files: ({ home }) => [{ path: join(home, 'a'), content: 7 }] });
  await assert.rejects(buildPlan({ ...ctx, adapters: [badContent], scope: 'user' }), { code: 'CONTEUDO_INVALIDO' });
});

test('erro lançado pelo adapter vira mensagem amigável com o nome da ferramenta', async (t) => {
  const ctx = await setup(t);
  const boom = { ...fakeAdapter('cursor'), plan: () => { throw new Error('payload incompleto: falta SKILL.md'); } };
  await assert.rejects(buildPlan({ ...ctx, adapters: [boom], scope: 'user' }), (err) => {
    assert.equal(err.code, 'ADAPTER_FALHOU');
    assert.match(err.message, /Ferramenta cursor/);
    assert.match(err.message, /falta SKILL\.md/);
    return true;
  });
});

test('destino atrás de link para fora da raiz é recusado', async (t) => {
  const ctx = await setup(t);
  const outside = join(ctx.cwd, 'alvo');
  await mkdir(outside);
  try {
    await symlink(outside, join(ctx.home, '.claude'), 'junction');
  } catch {
    t.skip('sem permissão para criar link nesta máquina');
    return;
  }
  await assert.rejects(buildPlan({ ...ctx, adapters: [fakeAdapter('claude')], scope: 'user' }), { code: 'DESTINO_LINK' });
});
