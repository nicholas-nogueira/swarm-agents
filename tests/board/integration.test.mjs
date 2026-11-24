import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, cleanup, run } from './helpers.mjs';
import { withLock } from '../../payload/skills/swarm/scripts/lib/store.mjs';

const exec = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'payload', 'skills', 'swarm', 'scripts', 'board.mjs');
const roots = [];
after(() => roots.forEach(cleanup));

function fresh() {
  const root = tempDir();
  roots.push(root);
  return root;
}

describe('concorrência entre processos', () => {
  test('20 posts em paralelo recebem seq único e contíguo', async () => {
    const dir = join(fresh(), 's');
    await exec(process.execPath, [SCRIPT, '--dir', dir, 'init', '--title', 'c']);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        exec(process.execPath, [SCRIPT, '--dir', dir, 'post', '--as', 'coordinator', '--text', `msg ${i}`]),
      ),
    );
    const seqs = readFileSync(join(dir, 'board.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq);
    assert.deepEqual(seqs.sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test('o board.mjs real lê o texto do stdin', async () => {
    const dir = join(fresh(), 's');
    await exec(process.execPath, [SCRIPT, '--dir', dir, 'init']);
    const out = execFileSync(process.execPath, [SCRIPT, '--dir', dir, 'post', '--as', 'coordinator'], {
      input: 'texto com "aspas" e\nquebra de linha',
      encoding: 'utf8',
    });
    assert.match(out, /#1/);
    assert.match(readFileSync(join(dir, 'board.jsonl'), 'utf8'), /quebra de linha/);
  });

  test('erro sai com código 2 e mensagem amigável no stderr', async () => {
    await assert.rejects(exec(process.execPath, [SCRIPT, 'init']), (e) => e.code === 2 && /--dir/.test(e.stderr));
  });
});

describe('lock', () => {
  test('lock velho (processo morto) é removido e a operação segue', async () => {
    const dir = fresh();
    const lock = join(dir, '.lock');
    writeFileSync(lock, '999999');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const v = await withLock(dir, async () => 42);
    assert.equal(v, 42);
    assert.equal(existsSync(lock), false);
  });

  test('lock preso e recente estoura o tempo com mensagem clara', async () => {
    const dir = fresh();
    writeFileSync(join(dir, '.lock'), String(process.pid));
    await assert.rejects(withLock(dir, async () => 1, { timeoutMs: 150 }), /ocupado/);
  });
});

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

describe('workspace share (git worktree com o estado não commitado)', () => {
  test('cria worktree que carrega mudanças locais e remove depois de integrado', async () => {
    const root = fresh();
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.txt'), 'v1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    writeFileSync(join(repo, 'a.txt'), 'v2 não commitado\n');
    writeFileSync(join(repo, 'novo.txt'), 'arquivo novo\n');

    const dir = join(root, 'swarm', 'sess');
    await run(['--dir', dir, 'init']);
    await run(['--dir', dir, 'member', 'add', '--name', 'ui', '--brief', 'b']);
    let r = await run(['--dir', dir, 'workspace', 'share', '--name', 'ui', '--repo', repo]);
    assert.equal(r.code, 0, r.err);
    const m = JSON.parse(readFileSync(join(dir, 'members.json'), 'utf8')).members.ui;
    assert.equal(m.workspace, 'share');
    // core.autocrlf pode converter o fim de linha no checkout; o conteúdo é o que importa.
    assert.equal(readFileSync(join(m.workspace_path, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'v2 não commitado\n');
    assert.ok(existsSync(join(m.workspace_path, 'novo.txt')));
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'v2 não commitado\n', 'o repo original não muda');

    // O snapshot do estado local vira um commit-base: o worktree começa limpo.
    assert.equal(git(m.workspace_path, 'status', '--porcelain'), '');
    assert.ok(m.base, 'guarda o commit-base do snapshot');

    // Nada do autor ainda: land avisa que não há o que integrar.
    r = await run(['--dir', dir, 'workspace', 'land', '--name', 'ui']);
    assert.match(r.out, /nada para integrar/i);

    // O autor commita no próprio branch; remover sem integrar é recusado.
    writeFileSync(join(m.workspace_path, 'b.txt'), 'feito pelo ui\n');
    git(m.workspace_path, 'add', 'b.txt');
    git(m.workspace_path, 'commit', '-q', '-m', 'ui');
    r = await run(['--dir', dir, 'workspace', 'remove', '--name', 'ui']);
    assert.equal(r.code, 2);
    assert.match(r.err, /integr/);

    // land aplica só os commits do autor no working copy (sem commitar), preservando as mudanças locais.
    r = await run(['--dir', dir, 'workspace', 'land', '--name', 'ui']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /b\.txt/);
    assert.equal(readFileSync(join(repo, 'b.txt'), 'utf8').replace(/\r\n/g, '\n'), 'feito pelo ui\n');
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'v2 não commitado\n');
    assert.equal(git(repo, 'log', '--oneline').split('\n').length, 1, 'land não cria commit no repo do usuário');

    // Integrado: remove passa e apaga worktree e branch.
    r = await run(['--dir', dir, 'workspace', 'remove', '--name', 'ui']);
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(m.workspace_path), false);
    assert.equal(git(repo, 'branch', '--list', m.branch), '');
  });

  test('remove aceita branch integrado por merge; land recusa conflito com mudança local', async () => {
    const root = fresh();
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.txt'), 'v1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const dir = join(root, 'swarm', 'sess');
    await run(['--dir', dir, 'init']);
    await run(['--dir', dir, 'member', 'add', '--name', 'x', '--brief', 'b']);
    await run(['--dir', dir, 'member', 'add', '--name', 'y', '--brief', 'b']);
    await run(['--dir', dir, 'workspace', 'share', '--name', 'x', '--repo', repo]);
    await run(['--dir', dir, 'workspace', 'share', '--name', 'y', '--repo', repo]);
    const ms = JSON.parse(readFileSync(join(dir, 'members.json'), 'utf8')).members;

    // x: integrado por merge comum.
    writeFileSync(join(ms.x.workspace_path, 'x.txt'), 'x\n');
    git(ms.x.workspace_path, 'add', 'x.txt');
    git(ms.x.workspace_path, 'commit', '-q', '-m', 'x');
    git(repo, 'merge', '-q', '--no-edit', ms.x.branch);
    let r = await run(['--dir', dir, 'workspace', 'remove', '--name', 'x']);
    assert.equal(r.code, 0, r.err);

    // y: mexe em a.txt, que o usuário também mudou localmente → conflito, nada é aplicado.
    writeFileSync(join(ms.y.workspace_path, 'a.txt'), 'do y\n');
    git(ms.y.workspace_path, 'commit', '-q', '-am', 'y');
    writeFileSync(join(repo, 'a.txt'), 'mudança local do usuário\n');
    r = await run(['--dir', dir, 'workspace', 'land', '--name', 'y']);
    assert.equal(r.code, 2);
    assert.match(r.err, /conflito/i);
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'mudança local do usuário\n', 'a mudança local é preservada');

    // land com o worktree sujo é recusado.
    writeFileSync(join(ms.y.workspace_path, 'sujo.txt'), 's');
    r = await run(['--dir', dir, 'workspace', 'land', '--name', 'y']);
    assert.match(r.err, /não commitadas/);
  });

  test('remove recusa mudanças não commitadas, mas --force passa por cima', async () => {
    const root = fresh();
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.txt'), 'v1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const dir = join(root, 'swarm', 'sess');
    await run(['--dir', dir, 'init']);
    await run(['--dir', dir, 'member', 'add', '--name', 'ui', '--brief', 'b']);
    await run(['--dir', dir, 'workspace', 'share', '--name', 'ui', '--repo', repo]);
    const m = JSON.parse(readFileSync(join(dir, 'members.json'), 'utf8')).members.ui;
    writeFileSync(join(m.workspace_path, 'sujo.txt'), 'x');
    let r = await run(['--dir', dir, 'workspace', 'remove', '--name', 'ui']);
    assert.match(r.err, /não commitadas/);
    r = await run(['--dir', dir, 'workspace', 'remove', '--name', 'ui', '--force']);
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(m.workspace_path), false);
  });

  test('member add --workspace share cria o worktree e o prompt manda trabalhar nele', async () => {
    const root = fresh();
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.txt'), 'v1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const dir = join(root, 'swarm', 'sess');
    await run(['--dir', dir, 'init']);
    let r = await run(['--dir', dir, 'member', 'add', '--name', 'api', '--workspace', 'share', '--repo', repo, '--brief', 'b']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /wt\/api/);
    assert.match(r.out, /commite/);

    // "prompt" reimprime o mesmo prompt (útil para retomar em modo Teams).
    r = await run(['--dir', dir, 'prompt', '--name', 'api']);
    assert.match(r.out, /wt\/api/);

    // Encerrar sem remover o workspace avisa que ele ainda existe.
    r = await run(['--dir', dir, 'member', 'kill', '--name', 'api']);
    assert.match(r.out, /ainda existe/);

    // Um branch com o mesmo nome já existente faz o share falhar e desfazer o que criou.
    await run(['--dir', dir, 'member', 'add', '--name', 'web', '--brief', 'b']);
    git(repo, 'branch', 'swarm/sess/web');
    r = await run(['--dir', dir, 'workspace', 'share', '--name', 'web', '--repo', repo]);
    assert.equal(r.code, 2);
    assert.match(r.err, /Falha ao criar o workspace/);
    assert.equal(existsSync(join(dir, 'wt', 'web')), false);
  });

  test('recusa share fora de repo git, em repo sem commit e workspace duplicado', async () => {
    const root = fresh();
    const dir = join(root, 'swarm', 'sess');
    await run(['--dir', dir, 'init']);
    await run(['--dir', dir, 'member', 'add', '--name', 'ui', '--brief', 'b']);
    let r = await run(['--dir', dir, 'workspace', 'share', '--name', 'ui', '--repo', root]);
    assert.equal(r.code, 2);
    assert.match(r.err, /git/);

    const empty = join(root, 'vazio');
    execFileSync('git', ['init', '-q', empty]);
    r = await run(['--dir', dir, 'workspace', 'share', '--name', 'ui', '--repo', empty]);
    assert.match(r.err, /commit/);

    r = await run(['--dir', dir, 'workspace', 'remove', '--name', 'ui']);
    assert.match(r.err, /não tem workspace/);
    r = await run(['--dir', dir, 'workspace', 'land', '--name', 'ui']);
    assert.match(r.err, /não tem workspace/);
  });
});
