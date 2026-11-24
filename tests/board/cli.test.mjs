import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanup, run } from './helpers.mjs';

let root;
let dir;
const D = () => ['--dir', dir];

beforeEach(async () => {
  root = tempDir();
  dir = join(root, 'swarm', 'sess-1');
  const r = await run([...D(), 'init', '--title', 'reescrita do parser']);
  assert.equal(r.code, 0, r.err);
});
afterEach(() => cleanup(root));

const members = () => JSON.parse(readFileSync(join(dir, 'members.json'), 'utf8')).members;
const board = () => readFileSync(join(dir, 'board.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('init', () => {
  test('cria board e roster com o coordinator', () => {
    assert.ok(existsSync(join(dir, 'board.jsonl')));
    assert.equal(members().coordinator.role, 'coordinator');
  });

  test('é idempotente: rodar de novo não apaga nada', async () => {
    await run([...D(), 'post', '--as', 'coordinator', '--text', 'oi']);
    const r = await run([...D(), 'init', '--title', 'outro']);
    assert.equal(r.code, 0);
    assert.match(r.out, /já existe/);
    assert.equal(board().length, 1);
  });

  test('--session resolve o diretório dentro de SWARM_HOME', async () => {
    const r = await run(['--session', 'abc-123', 'init', '--title', 't'], { env: { SWARM_HOME: root } });
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(root, 'abc-123', 'members.json')));
  });

  test('recusa session id com path traversal e --dir relativo', async () => {
    let r = await run(['--session', '../x', 'init'], { env: { SWARM_HOME: root } });
    assert.equal(r.code, 2);
    assert.match(r.err, /session/i);
    r = await run(['--dir', 'relativo/x', 'init']);
    assert.equal(r.code, 2);
    assert.match(r.err, /absoluto/);
  });

  test('sem --dir nem --session explica como usar', async () => {
    const r = await run(['init']);
    assert.equal(r.code, 2);
    assert.match(r.err, /--dir/);
  });
});

describe('member add', () => {
  test('publica o brief como @nome e imprime o prompt do worker', async () => {
    const r = await run([...D(), 'member', 'add', '--name', 'parser', '--role', 'worker'], {
      stdin: 'Você é dono de src/parser.js. Poste [done] com o diff.',
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Você acabou de começar/);
    const b = board();
    assert.equal(b[0].agent, 'coordinator');
    assert.match(b[0].text, /^@parser Você é dono/);
    assert.deepEqual(b[0].mentions, ['parser']);
    const m = members().parser;
    assert.equal(m.state, 'working');
    assert.equal(m.brief_seq, 1);
    assert.equal(m.last_read_seq, 1, 'o worker começa depois do próprio brief');
  });

  test('@outro dentro de um brief não acorda o outro (falso positivo do pending)', async () => {
    await run([...D(), 'member', 'add', '--name', 'verifier', '--role', 'verifier', '--brief', 'espere ser chamado']);
    await run([...D(), 'member', 'add', '--name', 'slug', '--brief', 'quando passar, poste @verifier']);
    const b = board().at(-1);
    assert.equal(b.kind, 'brief');
    assert.deepEqual(b.mentions, ['slug']);
    const r = await run([...D(), 'pending', '--json']);
    assert.deepEqual(JSON.parse(r.out).map((p) => p.name), []);
  });

  test('--n cria um grupo numerado com o mesmo brief', async () => {
    const r = await run([...D(), 'member', 'add', '--name', 'fix', '--n', '2', '--brief', 'Corrija um arquivo.']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(Object.keys(members()).sort(), ['coordinator', 'fix-1', 'fix-2']);
    assert.equal(board().length, 2);
  });

  test('helper com --parent reporta a quem o criou e o post sai em nome dele', async () => {
    await run([...D(), 'member', 'add', '--name', 'parser', '--brief', 'b']);
    const r = await run([...D(), 'member', 'add', '--name', 'lexer', '--parent', 'parser', '--brief', 'faça o lexer']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /@parser/);
    assert.equal(board()[1].agent, 'parser');
    assert.equal(members().lexer.parent, 'parser');
  });

  test('recusa sem brief, nome duplicado, nome morto, parent inexistente e papel inválido', async () => {
    let r = await run([...D(), 'member', 'add', '--name', 'x']);
    assert.equal(r.code, 2);
    assert.match(r.err, /brief/);

    await run([...D(), 'member', 'add', '--name', 'x', '--brief', 'b']);
    r = await run([...D(), 'member', 'add', '--name', 'x', '--brief', 'b']);
    assert.match(r.err, /já tem um membro/);

    await run([...D(), 'member', 'kill', '--name', 'x']);
    r = await run([...D(), 'member', 'add', '--name', 'x', '--brief', 'b']);
    assert.match(r.err, /não pode voltar/);

    r = await run([...D(), 'member', 'add', '--name', 'y', '--parent', 'ninguem', '--brief', 'b']);
    assert.match(r.err, /parent/);

    r = await run([...D(), 'member', 'add', '--name', 'z', '--role', 'chefe', '--brief', 'b']);
    assert.match(r.err, /role/);
  });

  test('sem init antes, avisa para rodar init', async () => {
    const r = await run(['--dir', join(root, 'nada'), 'member', 'add', '--name', 'a', '--brief', 'b']);
    assert.equal(r.code, 2);
    assert.match(r.err, /init/);
  });
});

describe('member update / kill', () => {
  beforeEach(async () => {
    await run([...D(), 'member', 'add', '--name', 'parser', '--brief', 'b']);
  });

  test('update grava estado e agent id', async () => {
    const r = await run([...D(), 'member', 'update', '--name', 'parser', '--state', 'waiting', '--agent-id', 'a1']);
    assert.equal(r.code, 0, r.err);
    assert.equal(members().parser.state, 'waiting');
    assert.equal(members().parser.agent_id, 'a1');
  });

  test('update recusa estado inválido, membro inexistente e membro morto', async () => {
    let r = await run([...D(), 'member', 'update', '--name', 'parser', '--state', 'dormindo']);
    assert.match(r.err, /state/);
    r = await run([...D(), 'member', 'update', '--name', 'fantasma', '--state', 'waiting']);
    assert.match(r.err, /não existe/);
    await run([...D(), 'member', 'kill', '--name', 'parser']);
    r = await run([...D(), 'member', 'update', '--name', 'parser', '--state', 'waiting']);
    assert.match(r.err, /morto/);
  });

  test('kill de um prefixo encerra o grupo numerado inteiro', async () => {
    await run([...D(), 'member', 'add', '--name', 'fix', '--n', '2', '--brief', 'b']);
    const r = await run([...D(), 'member', 'kill', '--name', 'fix']);
    assert.equal(r.code, 0, r.err);
    assert.equal(members()['fix-1'].state, 'killed');
    assert.equal(members()['fix-2'].state, 'killed');
  });

  test('kill recusa o coordinator e nomes desconhecidos', async () => {
    let r = await run([...D(), 'member', 'kill', '--name', 'coordinator']);
    assert.match(r.err, /coordinator/);
    r = await run([...D(), 'member', 'kill', '--name', 'ninguem']);
    assert.match(r.err, /não existe/);
  });

  test('membro morto não pode postar', async () => {
    await run([...D(), 'member', 'kill', '--name', 'parser']);
    const r = await run([...D(), 'post', '--as', 'parser', '--text', 'oi']);
    assert.equal(r.code, 2);
    assert.match(r.err, /morto/);
  });
});

describe('post / read / pending / status / render', () => {
  beforeEach(async () => {
    await run([...D(), 'member', 'add', '--name', 'parser', '--brief', 'b']); // #1
    await run([...D(), 'member', 'add', '--name', 'verifier', '--role', 'verifier', '--brief', 'v']); // #2
  });

  test('post via stdin devolve #seq e quem foi acordado', async () => {
    const r = await run([...D(), 'post', '--as', 'parser'], { stdin: '@verifier confira #1\n' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /#3/);
    assert.match(r.out, /verifier/);
  });

  test('post recusa autor desconhecido e texto vazio', async () => {
    let r = await run([...D(), 'post', '--as', 'intruso', '--text', 'oi']);
    assert.match(r.err, /não existe/);
    r = await run([...D(), 'post', '--as', 'parser', '--text', '  ']);
    assert.match(r.err, /obrigatório/);
    r = await run([...D(), 'post', '--as', 'parser']);
    assert.match(r.err, /texto/);
  });

  test('read --for avança o cursor e pula os próprios posts', async () => {
    await run([...D(), 'post', '--as', 'verifier', '--text', '@parser falha no caso vazio']); // #3
    let r = await run([...D(), 'read', '--for', 'parser']);
    assert.match(r.out, /#3 .*verifier: @parser falha/);
    assert.doesNotMatch(r.out, /#1 /, 'o brief já tinha sido lido');
    assert.equal(members().parser.last_read_seq, 3);
    r = await run([...D(), 'read', '--for', 'parser']);
    assert.match(r.out, /nada novo/i);
  });

  test('read --since, --seqs, --limit e --mentions-only', async () => {
    for (let i = 0; i < 5; i++) await run([...D(), 'post', '--as', 'parser', '--text', `nota ${i}`]); // #3..#7
    let r = await run([...D(), 'read', '--since', '5']);
    assert.match(r.out, /#6 /);
    assert.doesNotMatch(r.out, /#5 /);
    r = await run([...D(), 'read', '--seqs', '1,4']);
    assert.match(r.out, /#1 /);
    assert.match(r.out, /#4 /);
    assert.doesNotMatch(r.out, /#2 /);
    r = await run([...D(), 'read', '--limit', '2']);
    assert.match(r.out, /#6 [\s\S]*#7 /);
    assert.doesNotMatch(r.out, /#5 /);
    r = await run([...D(), 'read', '--for', 'verifier', '--mentions-only']);
    assert.doesNotMatch(r.out, /nota/);
    r = await run([...D(), 'read', '--json', '--seqs', '1']);
    assert.equal(JSON.parse(r.out)[0].seq, 1);
  });

  test('read --since recusa número inválido', async () => {
    const r = await run([...D(), 'read', '--since', 'abc']);
    assert.equal(r.code, 2);
    assert.match(r.err, /since/);
  });

  test('pending mostra quem acordar e status aponta resultado para ninguém', async () => {
    await run([...D(), 'member', 'update', '--name', 'parser', '--state', 'waiting']);
    await run([...D(), 'member', 'update', '--name', 'verifier', '--state', 'waiting']);
    await run([...D(), 'post', '--as', 'parser', '--text', '@verifier confira o diff']); // #3
    await run([...D(), 'post', '--as', 'parser', '--text', 'terminei o lexer']); // #4 (para ninguém)
    let r = await run([...D(), 'pending']);
    assert.match(r.out, /verifier.*#3/);
    r = await run([...D(), 'pending', '--json']);
    assert.ok(JSON.parse(r.out).some((p) => p.name === 'verifier'));
    r = await run([...D(), 'status']);
    assert.match(r.out, /parser/);
    assert.match(r.out, /waiting/);
    assert.match(r.out, /#4.*ninguém/);
    assert.match(r.out, /travado|acordar/i);
  });

  test('status --json e render', async () => {
    let r = await run([...D(), 'status', '--json']);
    const s = JSON.parse(r.out);
    assert.equal(s.title, 'reescrita do parser');
    assert.ok(s.members.parser);
    r = await run([...D(), 'render']);
    assert.match(r.out, /reescrita do parser/);
    assert.match(r.out, /#2 /);
  });

  test('pending vazio diz que não há ninguém para acordar', async () => {
    await run([...D(), 'read', '--for', 'parser']);
    await run([...D(), 'read', '--for', 'verifier']);
    const r = await run([...D(), 'pending']);
    assert.match(r.out, /ninguém/i);
  });
});

describe('robustez', () => {
  test('ignora linha corrompida no board e segue numerando', async () => {
    writeFileSync(join(dir, 'board.jsonl'), '{"seq":1,"agent":"coordinator","text":"ok","time":"t","mentions":[]}\n{quebrado\n');
    const r = await run([...D(), 'post', '--as', 'coordinator', '--text', 'segue']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /#2/);
  });

  test('comando desconhecido e ajuda', async () => {
    let r = await run([...D(), 'voar']);
    assert.equal(r.code, 2);
    assert.match(r.err, /desconhecido/);
    r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /member add/);
  });

  test('opção desconhecida, --backend inválido e --workspace inválido dão erro amigável', async () => {
    let r = await run([...D(), 'status', '--voar']);
    assert.equal(r.code, 2);
    assert.match(r.err, /--help/);
    r = await run(['--dir', join(root, 'b'), 'init', '--backend', 'nuvem']);
    assert.match(r.err, /backend/);
    r = await run([...D(), 'member', 'add', '--name', 'w', '--workspace', 'clone', '--brief', 'b']);
    assert.match(r.err, /workspace/);
  });

  test('init detecta o modo Teams pela variável de ambiente', async () => {
    const d = join(root, 't');
    await run(['--dir', d, 'init'], { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } });
    assert.equal(JSON.parse(readFileSync(join(d, 'members.json'), 'utf8')).backend, 'teams');
  });

  test('path imprime o diretório do swarm', async () => {
    const r = await run([...D(), 'path']);
    assert.equal(r.out.trim(), dir.replaceAll('\\', '/'));
  });
});
