// Testes funcionais da CLI: main(argv, ctx) com adapters falsos, HOME/cwd temporários e streams simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile, access, writeFile } from 'node:fs/promises';
import { main, loadAdapters } from '../../installer/cli.mjs';
import { makeTmp, writeTree, fakeAdapter, captureStream, inputFrom } from './helpers.mjs';

const exists = (p) => access(p).then(() => true, () => false);

async function setup(t, { adapters, tty = false, lines = [] } = {}) {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, 'home');
  const cwd = join(tmp.dir, 'proj');
  const payloadDir = join(tmp.dir, 'payload');
  await mkdir(home);
  await mkdir(cwd);
  await writeTree(payloadDir, {
    'skills/swarm/SKILL.md': 'skill',
    'skills/swarm/scripts/board.mjs': 'board',
    'agents/swarm-worker.md': 'worker',
  });
  const ctx = {
    adapters: adapters ?? [
      fakeAdapter('claude', { name: 'Claude Code', verified: 'native-claude' }),
      fakeAdapter('codex', { name: 'Codex', detected: false, notes: ['subagentes: não verificado'] }),
      fakeAdapter('antigravity', { name: 'Antigravity', defaultSelected: false, planNotes: ['O Antigravity já tem /swarm nativo; instalado como swarm-board.'] }),
    ],
    payloadDir,
    home,
    cwd,
    env: {},
    stdin: inputFrom(lines),
    stdout: captureStream(),
    stderr: captureStream(),
    isTTY: tty,
    nodeVersion: 'v24.15.0',
  };
  const run = async (...argv) => {
    ctx.stdout = captureStream();
    ctx.stderr = captureStream();
    const code = await main(argv, ctx);
    return { code, out: ctx.stdout.text(), err: ctx.stderr.text() };
  };
  return { ctx, run, home, cwd, mfile: join(home, '.swarm-agents', 'manifest.json') };
}

const skillOf = (root, id = 'claude') => join(root, `.${id}`, 'skills', 'swarm', 'SKILL.md');

test('help e comando desconhecido', async (t) => {
  const { run } = await setup(t);
  const h = await run('--help');
  assert.equal(h.code, 0);
  assert.match(h.out, /swarm-agents install/);
  assert.match(h.out, /--scope user\|project/);
  const bad = await run('instalar');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Comando desconhecido: "instalar"/);
});

test('opção desconhecida dá mensagem amigável', async (t) => {
  const { run } = await setup(t);
  const r = await run('install', '--cliente', 'claude');
  assert.equal(r.code, 1);
  assert.match(r.err, /Opção inválida/);
  assert.doesNotMatch(r.err, /at .*\.mjs/);
});

test('list mostra ferramentas, detecção, padrão, verificação e notas', async (t) => {
  const { run } = await setup(t);
  const r = await run('list');
  assert.equal(r.code, 0);
  assert.match(r.out, /claude\s+Claude Code/);
  assert.match(r.out, /detectado/);
  assert.match(r.out, /não detectado/);
  assert.match(r.out, /native-claude/);
  assert.match(r.out, /subagentes: não verificado/);
  assert.match(r.out, /antigravity.*desmarcado por padrão/);
});

test('install --client claude --yes grava, registra e informa o manifesto', async (t) => {
  const { run, home, mfile } = await setup(t);
  const r = await run('install', '--client', 'claude', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.equal(await readFile(skillOf(home), 'utf8'), 'skill');
  assert.match(r.out, /criar/);
  assert.match(r.out, /3 arquivo\(s\) gravado\(s\)/);
  assert.ok(r.out.includes(mfile));
  assert.match(r.out, /Reinicie Claude Code/);
  assert.doesNotMatch(r.out, /worker\n/, 'não loga conteúdo de arquivo');
});

test('reinstalar dá sem mudança e nada é gravado', async (t) => {
  const { run } = await setup(t);
  await run('install', '--client', 'claude', '--yes');
  const r = await run('install', '--client', 'claude', '--yes');
  assert.equal(r.code, 0);
  assert.match(r.out, /3 sem mudança/);
  assert.match(r.out, /Nada a gravar/);
});

test('--dry-run não escreve nada, nem o manifesto', async (t) => {
  const { run, home, mfile } = await setup(t);
  const r = await run('install', '--client', 'claude', '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Simulação/);
  assert.equal(await exists(join(home, '.claude')), false);
  assert.equal(await exists(mfile), false);
});

test('conflito sem --force: código 2 e dica; com --force grava com backup', async (t) => {
  const { run, home } = await setup(t);
  await writeTree(home, { '.claude/agents/swarm-worker.md': 'do usuário' });
  const r = await run('install', '--client', 'claude', '--yes');
  assert.equal(r.code, 2);
  assert.match(r.err, /--force/);
  assert.equal(await exists(skillOf(home)), false);
  const dry = await run('install', '--client', 'claude', '--dry-run');
  assert.equal(dry.code, 2);
  const f = await run('install', '--client', 'claude', '--yes', '--force');
  assert.equal(f.code, 0, f.err);
  assert.match(f.out, /backup/);
  assert.equal(await readFile(join(home, '.claude', 'agents', 'swarm-worker.md.swarm-agents.bak'), 'utf8'), 'do usuário');
});

test('cliente inexistente e escopo inválido dão mensagem amigável', async (t) => {
  const { run } = await setup(t);
  const c = await run('install', '--client', 'vscode', '--yes');
  assert.equal(c.code, 1);
  assert.match(c.err, /Ferramenta desconhecida: "vscode"/);
  assert.match(c.err, /claude, codex, antigravity/);
  const s = await run('install', '--client', 'claude', '--scope', 'global', '--yes');
  assert.equal(s.code, 1);
  assert.match(s.err, /Escopo inválido/);
});

test('--scope project grava sob o cwd', async (t) => {
  const { run, home, cwd } = await setup(t);
  const r = await run('install', '--client', 'codex', '--scope', 'project', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.ok(await exists(skillOf(cwd, 'codex')));
  assert.equal(await exists(join(home, '.codex')), false);
});

test('SWARM_AGENTS_HOME muda o lugar do manifesto', async (t) => {
  const { run, ctx, home } = await setup(t);
  ctx.env = { SWARM_AGENTS_HOME: join(home, 'estado') };
  const r = await run('install', '--client', 'claude', '--yes');
  assert.equal(r.code, 0);
  assert.ok(await exists(join(home, 'estado', 'manifest.json')));
});

test('sem --client e sem terminal: pede --client', async (t) => {
  const { run } = await setup(t);
  const r = await run('install', '--yes');
  assert.equal(r.code, 1);
  assert.match(r.err, /--client/);
});

test('sem --yes e sem terminal: pede --yes e não grava', async (t) => {
  const { run, home } = await setup(t);
  const r = await run('install', '--client', 'claude');
  assert.equal(r.code, 1);
  assert.match(r.err, /--yes/);
  assert.equal(await exists(join(home, '.claude')), false);
});

test('--all-detected pega só os detectados e marcados por padrão', async (t) => {
  const adapters = [
    fakeAdapter('claude'),
    fakeAdapter('codex', { detected: false }),
    fakeAdapter('antigravity', { defaultSelected: false, detected: true }),
  ];
  const { run, home } = await setup(t, { adapters });
  const r = await run('install', '--all-detected', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.ok(await exists(skillOf(home)));
  assert.equal(await exists(join(home, '.antigravity')), false);
  assert.match(r.out, /antigravity.*--client antigravity/);
});

test('--all-detected sem nada detectado: mensagem amigável', async (t) => {
  const { run } = await setup(t, { adapters: [fakeAdapter('claude', { detected: false })] });
  const r = await run('install', '--all-detected', '--yes');
  assert.equal(r.code, 1);
  assert.match(r.err, /Nenhuma ferramenta detectada/);
});

test('detect que lança erro conta como não detectado', async (t) => {
  const adapters = [fakeAdapter('claude', { detected: () => { throw new Error('x'); } })];
  const { run } = await setup(t, { adapters });
  const r = await run('list');
  assert.equal(r.code, 0);
  assert.match(r.out, /não detectado/);
});

test('modo interativo: Enter mantém a pré-seleção, escopo padrão user, confirma', async (t) => {
  const { run, home } = await setup(t, { tty: true, lines: ['', '', 's'] });
  const r = await run();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\[x\] Claude Code/);
  assert.match(r.out, /\[ \] Antigravity/);
  assert.match(r.out, /\[ \] Codex/);
  assert.ok(await exists(skillOf(home)));
});

test('modo interativo: marcar antigravity mostra o aviso; escopo project', async (t) => {
  const { run, cwd } = await setup(t, { tty: true, lines: ['1 3', '', '2', 's'] });
  const r = await run('install');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\/swarm nativo/);
  assert.ok(await exists(skillOf(cwd, 'antigravity')));
});

test('modo interativo: responder não cancela sem gravar', async (t) => {
  const { run, home } = await setup(t, { tty: true, lines: ['', '', 'n'] });
  const r = await run('install');
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /cancelad/);
  assert.equal(await exists(join(home, '.claude')), false);
});

test('modo interativo: nada marcado é erro amigável', async (t) => {
  const { run } = await setup(t, { tty: true, lines: ['nenhum', ''] });
  const r = await run('install');
  assert.equal(r.code, 1);
  assert.match(r.err, /Nenhuma ferramenta marcada/);
});

test('modo interativo com --client: pula a seleção mas confirma', async (t) => {
  const { run, home } = await setup(t, { tty: true, lines: ['s'] });
  const r = await run('install', '--client', 'claude', '--scope', 'user');
  assert.equal(r.code, 0, r.err);
  assert.ok(await exists(skillOf(home)));
});

const sharedAdapters = () => [
  fakeAdapter('codex', { name: 'Codex', dirName: '.agents' }),
  fakeAdapter('cursor', { name: 'Cursor', reads: ({ home, cwd, scope }) => [join(scope === 'user' ? home : cwd, '.agents', 'skills')] }),
];

test('pasta compartilhada: --dry-run e --yes mostram o mesmo aviso e não falham', async (t) => {
  const { run, home } = await setup(t, { adapters: sharedAdapters() });
  const dry = await run('install', '--client', 'codex', '--client', 'cursor', '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /ATENÇÃO/);
  assert.match(dry.out, /Cursor também lê .* e verá os arquivos adaptados para Codex/);
  const yes = await run('install', '--client', 'codex', '--client', 'cursor', '--yes');
  assert.equal(yes.code, 0, yes.err);
  assert.match(yes.out, /Cursor também lê .* e verá os arquivos adaptados para Codex/);
  assert.ok(await exists(join(home, '.agents', 'skills', 'swarm', 'SKILL.md')));
  const solo = await run('install', '--client', 'codex', '--dry-run');
  assert.doesNotMatch(solo.out, /ATENÇÃO/, 'sem o leitor selecionado, sem aviso');
});

test('pasta compartilhada: a confirmação interativa repete o aviso antes da pergunta', async (t) => {
  const { run } = await setup(t, { adapters: sharedAdapters(), tty: true, lines: ['s'] });
  const r = await run('install', '--client', 'codex', '--client', 'cursor', '--scope', 'user');
  assert.equal(r.code, 0, r.err);
  const lastWarning = r.out.lastIndexOf('verá os arquivos adaptados para Codex');
  const question = r.out.indexOf('Aplicar');
  assert.ok(r.out.indexOf('verá os arquivos adaptados para Codex') < r.out.indexOf('Resumo:'), 'aviso no plano');
  assert.ok(lastWarning > r.out.indexOf('Resumo:') && lastWarning < question, 'aviso repetido logo antes da confirmação');
  assert.match(r.out, /Aplicar .*1 aviso\(s\) de pasta compartilhada/);
});

test('uninstall: dry-run, confirmação, remoção e idempotência', async (t) => {
  const { run, home } = await setup(t);
  await run('install', '--client', 'claude', '--client', 'codex', '--yes');
  await writeTree(home, { '.claude/skills/minha/SKILL.md': 'minha' });
  const dry = await run('uninstall', '--dry-run');
  assert.equal(dry.code, 0);
  assert.match(dry.out, /remover/);
  assert.ok(await exists(skillOf(home)));
  const noYes = await run('uninstall');
  assert.equal(noYes.code, 1);
  assert.match(noYes.err, /--yes/);
  const one = await run('uninstall', '--client', 'codex', '--yes');
  assert.equal(one.code, 0, one.err);
  assert.equal(await exists(join(home, '.codex')), false);
  assert.ok(await exists(skillOf(home)));
  const all = await run('uninstall', '--yes');
  assert.equal(all.code, 0);
  assert.equal(await exists(join(home, '.claude', 'skills', 'swarm')), false);
  assert.equal(await readFile(join(home, '.claude', 'skills', 'minha', 'SKILL.md'), 'utf8'), 'minha');
  const again = await run('uninstall', '--yes');
  assert.equal(again.code, 0);
  assert.match(again.out, /Nada a remover/);
});

test('uninstall mantém arquivo modificado e avisa', async (t) => {
  const { run, home } = await setup(t);
  await run('install', '--client', 'claude', '--yes');
  await writeFile(skillOf(home), 'mexi');
  const r = await run('uninstall', '--yes');
  assert.equal(r.code, 0);
  assert.match(r.out, /mantido/);
  assert.equal(await readFile(skillOf(home), 'utf8'), 'mexi');
});

test('uninstall interativo confirma e valida cliente/escopo', async (t) => {
  const { run, ctx, home } = await setup(t);
  await run('install', '--client', 'claude', '--yes');
  const bad = await run('uninstall', '--client', 'nada', '--yes');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Ferramenta desconhecida/);
  const badScope = await run('uninstall', '--scope', 'x', '--yes');
  assert.equal(badScope.code, 1);
  ctx.isTTY = true;
  ctx.stdin = inputFrom(['s']);
  const r = await run('uninstall', '--scope', 'user');
  assert.equal(r.code, 0, r.err);
  assert.equal(await exists(skillOf(home)), false);
});

test('doctor: 0 quando íntegro, 1 quando há problema', async (t) => {
  const { run, home } = await setup(t);
  await run('install', '--client', 'claude', '--yes');
  const ok = await run('doctor');
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /\[ok\]/);
  await writeFile(skillOf(home), 'mexi');
  const bad = await run('doctor');
  assert.equal(bad.code, 1);
  assert.match(bad.out, /\[erro\].*modificado/);
});

test('payload ausente e manifesto inválido dão mensagem amigável', async (t) => {
  const { run, ctx, mfile } = await setup(t);
  const saved = ctx.payloadDir;
  ctx.payloadDir = join(ctx.home, 'sem-payload');
  const p = await run('install', '--client', 'claude', '--yes');
  assert.equal(p.code, 1);
  assert.match(p.err, /payload/i);
  ctx.payloadDir = saved;
  await writeTree(ctx.home, { '.swarm-agents/manifest.json': 'lixo' });
  const m = await run('install', '--client', 'claude', '--yes');
  assert.equal(m.code, 1);
  assert.match(m.err, /manifesto/i);
  assert.ok(m.err.includes(mfile));
});

test('erro inesperado vira mensagem genérica sem stack', async (t) => {
  const boom = { ...fakeAdapter('claude'), notes: null };
  Object.defineProperty(boom, 'notes', { get() { throw new TypeError('quebra interna'); } });
  const { run } = await setup(t, { adapters: [boom] });
  const r = await run('list');
  assert.equal(r.code, 1);
  assert.match(r.err, /Erro inesperado/);
  assert.doesNotMatch(r.err, /at .*\.mjs/);
});

test('loadAdapters aceita listAdapters() com objetos, ids, ou só ADAPTERS', () => {
  const a = fakeAdapter('claude');
  assert.deepEqual(loadAdapters({ listAdapters: () => [a] }), [a]);
  assert.deepEqual(loadAdapters({ ADAPTERS: { claude: a }, listAdapters: () => ['claude'] }), [a]);
  assert.deepEqual(loadAdapters({ ADAPTERS: { claude: a } }), [a]);
  assert.throws(() => loadAdapters({}), { code: 'ADAPTERS_AUSENTES' });
});
