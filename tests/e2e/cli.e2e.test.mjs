// Testes e2e: a CLI real (bin/swarm-agents.mjs) com os adapters reais e o payload real,
// sempre num HOME e cwd temporários. Provam a REGRA 1 (Claude byte-idêntico ao baseline) e o ciclo completo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { sandbox, tree, baselineRuntime, exists, GOLDEN } from './helpers.mjs';

const ALL = ['claude', 'codex', 'cursor', 'opencode', 'gemini', 'antigravity'];
const clientArgs = (ids) => ids.flatMap((id) => ['--client', id]);
const noStack = (s) => assert.doesNotMatch(s, /\n\s+at .+\.m?js:\d+/);

test('linha de base do repositório é a mesma capturada antes da fase 2', async (t) => {
  const research = 'C:\\Projetos\\REA\\tasks\\research\\baseline-claude.sha256';
  if (!(await exists(research))) {
    t.skip('baseline de pesquisa não está nesta máquina');
    return;
  }
  assert.ok((await readFile(research)).equals(await readFile(GOLDEN)));
});

test('list mostra as 6 ferramentas', async (t) => {
  const { run } = await sandbox(t);
  const r = run('list');
  assert.equal(r.code, 0, r.err);
  for (const id of ALL) assert.match(r.out, new RegExp(`^\\s+${id}\\s`, 'm'));
});

test('REGRA 1: claude instalado é byte-idêntico ao baseline e não grava nada além disso', async (t) => {
  const { run, home } = await sandbox(t);
  const r = run('install', '--client', 'claude', '--yes');
  assert.equal(r.code, 0, r.err);
  const installed = await tree(join(home, '.claude'));
  const baseline = await baselineRuntime();
  assert.deepEqual([...installed.keys()].sort(), [...baseline.keys()].sort());
  for (const [rel, hash] of baseline) assert.equal(installed.get(rel), hash, `divergência em ${rel}`);
  const top = (await tree(home)).keys();
  for (const rel of top) assert.ok(rel.startsWith('.claude/') || rel === '.swarm-agents/manifest.json', `arquivo inesperado: ${rel}`);
});

test('reinstalar dá unchanged e não reescreve nem o manifesto', async (t) => {
  const { run, home } = await sandbox(t);
  assert.equal(run('install', '--client', 'claude', '--yes').code, 0);
  const mfile = join(home, '.swarm-agents', 'manifest.json');
  const before = await readFile(mfile);
  const snap = await tree(home);
  const r = run('install', '--client', 'claude', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /0 a criar, 0 a atualizar, \d+ sem mudança, 0 conflito/);
  assert.match(r.out, /Nada a gravar/);
  assert.ok((await readFile(mfile)).equals(before));
  assert.deepEqual(await tree(home), snap);
});

test('uninstall remove só o que é nosso', async (t) => {
  const { run, home } = await sandbox(t);
  await mkdir(join(home, '.claude', 'skills', 'minha'), { recursive: true });
  await mkdir(join(home, '.claude', 'agents'), { recursive: true });
  await writeFile(join(home, '.claude', 'skills', 'minha', 'SKILL.md'), 'skill do usuário');
  await writeFile(join(home, '.claude', 'agents', 'meu-agente.md'), 'agente do usuário');
  assert.equal(run('install', '--client', 'claude', '--yes').code, 0);
  const r = run('uninstall', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.equal(await exists(join(home, '.claude', 'skills', 'swarm')), false);
  assert.equal(await exists(join(home, '.claude', 'agents', 'swarm-worker.md')), false);
  assert.equal(await exists(join(home, '.claude', 'agents', 'swarm-verifier.md')), false);
  assert.equal(await readFile(join(home, '.claude', 'skills', 'minha', 'SKILL.md'), 'utf8'), 'skill do usuário');
  assert.equal(await readFile(join(home, '.claude', 'agents', 'meu-agente.md'), 'utf8'), 'agente do usuário');
  const again = run('uninstall', '--yes');
  assert.equal(again.code, 0);
  assert.match(again.out, /Nada a remover/);
});

test('conflito sem --force dá código 2 e não grava nada; com --force grava com backup', async (t) => {
  const { run, home } = await sandbox(t);
  const worker = join(home, '.claude', 'agents', 'swarm-worker.md');
  await mkdir(join(home, '.claude', 'agents'), { recursive: true });
  await writeFile(worker, 'worker do usuário');
  const r = run('install', '--client', 'claude', '--yes');
  assert.equal(r.code, 2);
  assert.match(r.err, /--force/);
  noStack(r.err);
  assert.equal(await readFile(worker, 'utf8'), 'worker do usuário');
  assert.equal(await exists(join(home, '.claude', 'skills')), false);
  assert.equal(await exists(join(home, '.swarm-agents')), false);
  const f = run('install', '--client', 'claude', '--yes', '--force');
  assert.equal(f.code, 0, f.err);
  assert.equal(await readFile(`${worker}.swarm-agents.bak`, 'utf8'), 'worker do usuário');
  const baseline = await baselineRuntime();
  const installed = await tree(join(home, '.claude'));
  assert.equal(installed.get('agents/swarm-worker.md'), baseline.get('agents/swarm-worker.md'));
});

test('--dry-run com todas as ferramentas não escreve nada', async (t) => {
  const { run, home, cwd } = await sandbox(t);
  for (const scope of ['user', 'project']) {
    const r = run('install', ...clientArgs(ALL), '--scope', scope, '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Simulação/);
    if (scope === 'user') {
      // Um aviso por pasta distinta (não agrupados): 8 com as 6 ferramentas no escopo user.
      const warnings = r.out.split('\n').filter((l) => /também lê .* e verá os arquivos adaptados para/.test(l));
      assert.equal(warnings.length, 8, warnings.join('\n'));
      assert.equal(new Set(warnings).size, 8);
    }
  }
  assert.equal((await tree(home)).size, 0);
  assert.equal((await tree(cwd)).size, 0);
});

test('escopo project grava sob o cwd (e só o manifesto no home)', async (t) => {
  const { run, home, cwd } = await sandbox(t);
  const r = run('install', '--client', 'claude', '--scope', 'project', '--yes');
  assert.equal(r.code, 0, r.err);
  const installed = await tree(join(cwd, '.claude'));
  const baseline = await baselineRuntime();
  assert.deepEqual([...installed.keys()].sort(), [...baseline.keys()].sort());
  assert.deepEqual([...(await tree(home)).keys()], ['.swarm-agents/manifest.json']);
});

test('cliente inexistente e escopo inválido dão mensagem amigável', async (t) => {
  const { run, home } = await sandbox(t);
  const r = run('install', '--client', 'vscode', '--yes');
  assert.equal(r.code, 1);
  assert.match(r.err, /Ferramenta desconhecida: "vscode"/);
  assert.match(r.err, new RegExp(ALL.join(', ')));
  noStack(r.err);
  const s = run('install', '--client', 'claude', '--scope', 'global', '--yes');
  assert.equal(s.code, 1);
  assert.match(s.err, /Escopo inválido/);
  const o = run('install', '--client', 'claude', '--sim');
  assert.equal(o.code, 1);
  assert.match(o.err, /Opção inválida/);
  assert.equal((await tree(home)).size, 0);
});

test('sem terminal e sem --client: pede --client, não grava', async (t) => {
  const { run, home } = await sandbox(t);
  const r = run();
  assert.equal(r.code, 1);
  assert.match(r.err, /--client/);
  assert.equal((await tree(home)).size, 0);
});

for (const scope of ['user', 'project']) {
  test(`ciclo completo com as 6 ferramentas (escopo ${scope}): install, doctor, reinstall, uninstall`, async (t) => {
    const { run, home, cwd } = await sandbox(t);
    const root = scope === 'user' ? home : cwd;
    const r = run('install', ...clientArgs(ALL), '--scope', scope, '--yes');
    assert.equal(r.code, 0, r.err || r.out);
    assert.match(r.out, /\[antigravity\]/, 'o aviso do Antigravity aparece no plano');
    const snap = await tree(root);
    assert.ok(snap.size > 0);
    const d = run('doctor');
    assert.equal(d.code, 0, d.out);
    for (const id of ALL) assert.match(d.out, new RegExp(`\\[ok\\] ${id} \\(${scope}`));
    const again = run('install', ...clientArgs(ALL), '--scope', scope, '--yes');
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /Nada a gravar/);
    assert.deepEqual(await tree(root), snap);
    const u = run('uninstall', '--scope', scope, '--yes');
    assert.equal(u.code, 0, u.err);
    const left = [...(await tree(root)).keys()].filter((k) => k !== '.swarm-agents/manifest.json');
    assert.deepEqual(left, []);
  });
}

test('pasta compartilhada com adapters reais: Codex + Cursor avisa em --dry-run e --yes, sem mudar destinos', async (t) => {
  const { run, home } = await sandbox(t);
  const solo = run('install', '--client', 'codex', '--dry-run');
  assert.equal(solo.code, 0, solo.err);
  assert.doesNotMatch(solo.out, /ATENÇÃO/);
  const dry = run('install', '--client', 'codex', '--client', 'cursor', '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  const agentsSkills = join(home, '.agents', 'skills').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  assert.match(dry.out, new RegExp(`Cursor também lê ${agentsSkills} e verá os arquivos adaptados para Codex`));
  const planned = (out) => out.split('\n').filter((l) => /^\s+criar\s/.test(l)).sort();
  const codexOnly = planned(solo.out);
  assert.ok(codexOnly.every((l) => planned(dry.out).includes(l)), 'os destinos do Codex não mudam com o Cursor junto');
  const yes = run('install', '--client', 'codex', '--client', 'cursor', '--yes');
  assert.equal(yes.code, 0, yes.err);
  assert.match(yes.out, /Cursor também lê .* e verá os arquivos adaptados para Codex/);
  assert.ok(await exists(join(home, '.agents', 'skills', 'swarm', 'SKILL.md')));
  assert.ok(await exists(join(home, '.cursor', 'skills', 'swarm', 'SKILL.md')));
});

test('--all-detected sem nenhuma ferramenta no HOME vazio: mensagem amigável', async (t) => {
  const { run } = await sandbox(t);
  const r = run('install', '--all-detected', '--yes');
  assert.equal(r.code, 1);
  assert.match(r.err, /Nenhuma ferramenta detectada/);
});

test('--all-detected com ~/.claude presente instala o claude e deixa o antigravity de fora', async (t) => {
  const { run, home } = await sandbox(t);
  await mkdir(join(home, '.claude'));
  await mkdir(join(home, '.gemini', 'antigravity'), { recursive: true });
  const r = run('install', '--all-detected', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.ok(await exists(join(home, '.claude', 'skills', 'swarm', 'SKILL.md')));
  assert.match(r.out, /antigravity: detectado, mas fica de fora/);
  assert.equal(await exists(join(home, '.gemini', 'config')), false);
});
