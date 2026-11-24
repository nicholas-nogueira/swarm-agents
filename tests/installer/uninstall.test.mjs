import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, access, rm, symlink } from 'node:fs/promises';
import { buildPlan } from '../../installer/plan.mjs';
import { applyPlan } from '../../installer/apply.mjs';
import { planUninstall, applyUninstall } from '../../installer/uninstall.mjs';
import { emptyManifest, loadManifest, listEntries, setEntry, saveManifest } from '../../installer/manifest.mjs';
import { makeTmp, writeTree, fakePayload, fakeAdapter } from './helpers.mjs';

const exists = (p) => access(p).then(() => true, () => false);

async function installed(t, adapters = [fakeAdapter('claude')], scope = 'user') {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, 'home');
  const cwd = join(tmp.dir, 'proj');
  await mkdir(home);
  await mkdir(cwd);
  const mfile = join(home, '.swarm-agents', 'manifest.json');
  const payload = fakePayload();
  const manifest = emptyManifest();
  await applyPlan(await buildPlan({ home, cwd, payload, manifest, adapters, scope }), { manifest, manifestFile: mfile });
  return { home, cwd, mfile, payload, manifest: await loadManifest(mfile) };
}

test('remove só os arquivos registrados e intactos, e os diretórios que criamos vazios', async (t) => {
  const ctx = await installed(t);
  await writeTree(ctx.home, { '.claude/skills/outra/SKILL.md': 'skill do usuário' });
  const actions = await planUninstall({ manifest: ctx.manifest });
  assert.ok(actions.every((a) => a.op === 'remove'));
  const res = await applyUninstall(actions, { manifest: ctx.manifest, manifestFile: ctx.mfile });
  assert.equal(res.removed.length, 3);
  assert.equal(await exists(join(ctx.home, '.claude', 'skills', 'swarm')), false);
  assert.equal(await exists(join(ctx.home, '.claude', 'agents')), false);
  assert.equal(await readFile(join(ctx.home, '.claude', 'skills', 'outra', 'SKILL.md'), 'utf8'), 'skill do usuário');
  assert.equal(listEntries(await loadManifest(ctx.mfile)).length, 0);
});

test('arquivo modificado pelo usuário é mantido e deixa de ser nosso', async (t) => {
  const ctx = await installed(t);
  const worker = join(ctx.home, '.claude', 'agents', 'swarm-worker.md');
  await writeFile(worker, 'editado pelo usuário');
  const actions = await planUninstall({ manifest: ctx.manifest });
  assert.equal(actions.find((a) => a.path === worker).op, 'keep-modified');
  const res = await applyUninstall(actions, { manifest: ctx.manifest, manifestFile: ctx.mfile });
  assert.deepEqual(res.kept, [worker]);
  assert.equal(await readFile(worker, 'utf8'), 'editado pelo usuário');
  assert.equal(listEntries(await loadManifest(ctx.mfile)).length, 0);
});

test('arquivo já apagado vira missing e sai do manifesto', async (t) => {
  const ctx = await installed(t);
  const worker = join(ctx.home, '.claude', 'agents', 'swarm-worker.md');
  await rm(worker);
  const actions = await planUninstall({ manifest: ctx.manifest });
  assert.equal(actions.find((a) => a.path === worker).op, 'missing');
  await applyUninstall(actions, { manifest: ctx.manifest, manifestFile: ctx.mfile });
  assert.equal(listEntries(await loadManifest(ctx.mfile)).length, 0);
});

test('filtro por cliente: arquivo compartilhado só é desvinculado; o exclusivo sai', async (t) => {
  const shared = (id) => fakeAdapter(id, { dirName: '.agents' });
  const ctx = await installed(t, [shared('codex'), shared('gemini'), fakeAdapter('claude')]);
  const actions = await planUninstall({ manifest: ctx.manifest, clients: ['codex'] });
  assert.ok(actions.length === 3 && actions.every((a) => a.op === 'detach'));
  await applyUninstall(actions, { manifest: ctx.manifest, manifestFile: ctx.mfile });
  const m = await loadManifest(ctx.mfile);
  assert.ok(listEntries(m).filter((e) => e.path.includes('.agents')).every((e) => e.clients.join() === 'gemini'));
  assert.ok(await exists(join(ctx.home, '.agents', 'skills', 'swarm', 'SKILL.md')));
  const again = await planUninstall({ manifest: m, clients: ['gemini'] });
  assert.ok(again.every((a) => a.op === 'remove'));
  await applyUninstall(again, { manifest: m, manifestFile: ctx.mfile });
  assert.equal(await exists(join(ctx.home, '.agents')), false);
  assert.ok(await exists(join(ctx.home, '.claude', 'skills', 'swarm', 'SKILL.md')));
});

test('filtro por escopo', async (t) => {
  const ctx = await installed(t);
  assert.equal((await planUninstall({ manifest: ctx.manifest, scope: 'project' })).length, 0);
  assert.equal((await planUninstall({ manifest: ctx.manifest, scope: 'user' })).length, 3);
});

test('rodar de novo não encontra nada (idempotente)', async (t) => {
  const ctx = await installed(t);
  await applyUninstall(await planUninstall({ manifest: ctx.manifest }), { manifest: ctx.manifest, manifestFile: ctx.mfile });
  assert.deepEqual(await planUninstall({ manifest: await loadManifest(ctx.mfile) }), []);
});

test('entrada adulterada fora da raiz registrada é ignorada como insegura', async (t) => {
  const ctx = await installed(t);
  const outside = join(ctx.cwd, 'vitima.txt');
  await writeFile(outside, 'não me apague');
  const m = emptyManifest();
  setEntry(m, { path: outside, clients: ['claude'], scope: 'user', root: ctx.home, sha256: 'x' });
  await saveManifest(ctx.mfile, m);
  const actions = await planUninstall({ manifest: await loadManifest(ctx.mfile) });
  assert.equal(actions[0].op, 'skip-unsafe');
  await applyUninstall(actions, { manifest: m, manifestFile: ctx.mfile });
  assert.equal(await readFile(outside, 'utf8'), 'não me apague');
});

test('destino que virou diretório ou link não é removido', async (t) => {
  const ctx = await installed(t);
  const worker = join(ctx.home, '.claude', 'agents', 'swarm-worker.md');
  await rm(worker);
  await mkdir(worker);
  const actions = await planUninstall({ manifest: ctx.manifest });
  assert.equal(actions.find((a) => a.path === worker).op, 'skip-unsafe');
  await rm(worker, { recursive: true });
  try {
    await symlink(ctx.cwd, worker, 'junction');
  } catch {
    return;
  }
  const again = await planUninstall({ manifest: ctx.manifest });
  assert.equal(again.find((a) => a.path === worker).op, 'skip-unsafe');
});

test('falha ao remover um arquivo é reportada sem apagar os demais registros', async (t) => {
  const ctx = await installed(t);
  const actions = await planUninstall({ manifest: ctx.manifest });
  const io = { unlink: async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } };
  await assert.rejects(applyUninstall(actions, { manifest: ctx.manifest, manifestFile: ctx.mfile, io }), { code: 'FALHA_NA_REMOCAO' });
  assert.equal(listEntries(await loadManifest(ctx.mfile)).length, 3);
});
