import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { buildPlan } from '../../installer/plan.mjs';
import { applyPlan } from '../../installer/apply.mjs';
import { runDoctor } from '../../installer/doctor.mjs';
import { emptyManifest, loadManifest, setEntry } from '../../installer/manifest.mjs';
import { makeTmp, fakePayload, fakeAdapter } from './helpers.mjs';

async function setup(t, scope = 'user') {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, 'home');
  const cwd = join(tmp.dir, 'proj');
  await mkdir(home);
  await mkdir(cwd);
  const mfile = join(home, '.swarm-agents', 'manifest.json');
  const payload = fakePayload();
  const adapters = [fakeAdapter('claude'), fakeAdapter('codex', { detected: false })];
  const manifest = emptyManifest();
  await applyPlan(await buildPlan({ home, cwd, payload, manifest, adapters: [adapters[0]], scope }), { manifest, manifestFile: mfile });
  return { home, cwd, mfile, payload, adapters, manifest: await loadManifest(mfile) };
}

const levels = (r) => r.checks.map((c) => c.level);

test('instalação íntegra: ok, com versão do Node, payload e cliente atual', async (t) => {
  const ctx = await setup(t);
  const r = await runDoctor({ ...ctx, manifestFile: ctx.mfile, env: {}, nodeVersion: 'v24.15.0' });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.ok(levels(r).every((l) => l === 'ok'));
  const text = r.checks.map((c) => c.text).join('\n');
  assert.match(text, /Node v24\.15\.0/);
  assert.match(text, /claude.*atual/);
});

test('Node antigo é erro', async (t) => {
  const ctx = await setup(t);
  const r = await runDoctor({ ...ctx, manifestFile: ctx.mfile, env: {}, nodeVersion: 'v20.1.0' });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.level === 'erro' && /Node/.test(c.text)));
});

test('arquivo apagado ou modificado aparece como erro com dica de reinstalar', async (t) => {
  const ctx = await setup(t);
  await rm(join(ctx.home, '.claude', 'agents', 'swarm-worker.md'));
  await writeFile(join(ctx.home, '.claude', 'skills', 'swarm', 'SKILL.md'), 'editado');
  const r = await runDoctor({ ...ctx, manifestFile: ctx.mfile, env: {}, nodeVersion: 'v24.0.0' });
  assert.equal(r.ok, false);
  const text = r.checks.map((c) => c.text).join('\n');
  assert.match(text, /ausente/);
  assert.match(text, /modificado/);
  assert.match(text, /swarm-agents install --client claude --scope user/);
});

test('payload novo (cliente desatualizado) é aviso', async (t) => {
  const ctx = await setup(t);
  const payload = fakePayload({ 'skills/swarm/novo.md': 'novo' });
  const r = await runDoctor({ ...ctx, payload, manifestFile: ctx.mfile, env: {}, nodeVersion: 'v24.0.0' });
  assert.ok(r.checks.some((c) => c.level === 'aviso' && /desatualizad/.test(c.text)));
  assert.equal(r.ok, true);
});

test('sem nada instalado: aviso informativo, ok', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const r = await runDoctor({
    adapters: [fakeAdapter('claude')],
    manifest: emptyManifest(),
    manifestFile: join(tmp.dir, 'm.json'),
    payload: fakePayload(),
    home: tmp.dir,
    env: {},
    nodeVersion: 'v24.0.0',
  });
  assert.equal(r.ok, true);
  assert.ok(r.checks.some((c) => /Nada instalado/.test(c.text)));
});

test('cliente registrado que não existe mais nos adapters é aviso; adapter que falha é erro', async (t) => {
  const ctx = await setup(t);
  const m = await loadManifest(ctx.mfile);
  setEntry(m, { path: join(ctx.home, '.velho', 'x'), clients: ['velho'], scope: 'user', root: ctx.home, sha256: 'a' });
  const boom = { ...fakeAdapter('claude'), plan: () => { throw new Error('quebrou'); } };
  const r = await runDoctor({ ...ctx, adapters: [boom], manifest: m, manifestFile: ctx.mfile, env: {}, nodeVersion: 'v24.0.0' });
  const text = r.checks.map((c) => `${c.level}:${c.text}`).join('\n');
  assert.match(text, /aviso:.*velho/);
  assert.match(text, /erro:.*quebrou/);
});

test('escopo project é conferido usando a raiz registrada como cwd', async (t) => {
  const ctx = await setup(t, 'project');
  const r = await runDoctor({ ...ctx, manifestFile: ctx.mfile, env: {}, nodeVersion: 'v24.0.0' });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.match(r.checks.map((c) => c.text).join('\n'), /claude \(project/);
});
