import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SwarmError,
  validateName,
  validateText,
  mentionsOf,
  concerns,
  unreadFor,
  pendingWakeups,
  unaddressedSince,
  numberedCopies,
  groupMembers,
  formatPost,
  workerPrompt,
  MAX_TEXT,
} from '../../payload/skills/swarm/scripts/lib/board-core.mjs';

const post = (seq, agent, text) => ({ seq, agent, text, time: '2026-11-19T10:00:00.000Z' });

describe('validateName', () => {
  test('aceita nomes de função curtos', () => {
    for (const n of ['parser', 'api-tests', 'fix_1', '9lives', 'fix-12']) validateName(n);
  });

  test('recusa vazio, maiúsculas, caracteres inválidos e nomes longos', () => {
    for (const n of ['', 'Parser', '-x', 'a b', 'ação', 'x'.repeat(25), undefined]) {
      assert.throws(() => validateName(n), SwarmError, `deveria recusar ${n}`);
    }
  });

  test('recusa nomes reservados', () => {
    for (const n of ['all', 'coordinator', 'coordinator-2']) {
      assert.throws(() => validateName(n), /reservado/);
    }
  });

  test('a mensagem de erro de nome longo sugere nomear pela função', () => {
    assert.throws(() => validateName('a'.repeat(30)), /função/);
  });
});

describe('validateText', () => {
  test('recusa texto vazio ou só espaços', () => {
    assert.throws(() => validateText('   '), /obrigatório/);
    assert.throws(() => validateText(undefined), /obrigatório/);
  });

  test('recusa texto acima do limite', () => {
    assert.throws(() => validateText('x'.repeat(MAX_TEXT + 1)), /longo/);
  });

  test('devolve o texto sem espaços nas pontas', () => {
    assert.equal(validateText('  oi  '), 'oi');
  });
});

describe('mentionsOf (espelha board/mentions.go)', () => {
  const names = ['parser', 'verifier', 'fix-1', 'fix-2', 'coordinator'];

  test('acha @nome no início de palavra, sem diferenciar maiúsculas', () => {
    assert.deepEqual(mentionsOf('@Parser veja #4', names), { mentions: ['parser'], all: false });
  });

  test('ignora @ no meio de palavra (e-mail) e nome seguido de mais caracteres de nome', () => {
    assert.deepEqual(mentionsOf('mail a@parser.com', names).mentions, []);
    assert.deepEqual(mentionsOf('@parsers não é ninguém', names).mentions, []);
    assert.deepEqual(mentionsOf('@parser_x', names).mentions, []);
  });

  test('aceita pontuação logo depois do nome', () => {
    assert.deepEqual(mentionsOf('@verifier, @parser: ok', names).mentions, ['parser', 'verifier']);
  });

  test('@prefixo acorda o grupo numerado inteiro, @fix-1 só a cópia', () => {
    assert.deepEqual(mentionsOf('@fix pegue um arquivo', names).mentions, ['fix-1', 'fix-2']);
    assert.deepEqual(mentionsOf('@fix-1 só você', names).mentions, ['fix-1']);
  });

  test('@all é broadcast', () => {
    assert.equal(mentionsOf('@all regra nova', names).all, true);
    assert.equal(mentionsOf('@allison', names).all, false);
  });

  test('texto vazio ou sem nomes não menciona ninguém', () => {
    assert.deepEqual(mentionsOf('', names), { mentions: [], all: false });
    assert.deepEqual(mentionsOf(null, []), { mentions: [], all: false });
  });
});

describe('concerns / unreadFor / pendingWakeups', () => {
  const members = {
    coordinator: { role: 'coordinator', state: 'working', last_read_seq: 3 },
    parser: { role: 'worker', state: 'waiting', last_read_seq: 1 },
    verifier: { role: 'verifier', state: 'waiting', last_read_seq: 0 },
    old: { role: 'worker', state: 'killed', last_read_seq: 0 },
  };
  const posts = [
    post(1, 'coordinator', '@parser você é dono de src/parser.js'),
    post(2, 'parser', '@verifier confira #1'),
    post(3, 'parser', 'parser.js pronto, expõe parse(text)'),
    post(4, 'verifier', '@parser falha no caso vazio, ver teste x'),
    post(5, 'coordinator', '@all congelem a API'),
    post(6, 'parser', '@coordinator [done] ok'),
  ];

  test('concerns: menção direta ou @all; nunca o próprio post', () => {
    assert.equal(concerns(posts[0], 'parser', Object.keys(members)), true);
    assert.equal(concerns(posts[4], 'verifier', Object.keys(members)), true);
    assert.equal(concerns(posts[1], 'parser', Object.keys(members)), false);
  });

  test('um post de brief só chama o dono, mesmo citando outros (@verifier no texto)', () => {
    const brief = { seq: 9, agent: 'coordinator', kind: 'brief', mentions: ['parser'], text: '@parser quando passar, poste @verifier' };
    const names = Object.keys(members);
    assert.equal(concerns(brief, 'parser', names), true);
    assert.equal(concerns(brief, 'verifier', names), false);
  });

  test('unreadFor ignora os posts do próprio autor', () => {
    const unread = unreadFor('parser', members, posts);
    assert.deepEqual(unread.all.map((p) => p.seq), [4, 5]);
    assert.deepEqual(unread.mentions.map((p) => p.seq), [4, 5]);
  });

  test('pendingWakeups lista quem tem menção não lida e não está morto', () => {
    const pend = pendingWakeups(members, posts);
    assert.deepEqual(pend.map((p) => [p.name, p.seqs]), [
      ['coordinator', [6]], // o #5 (@all) é do próprio coordinator
      ['parser', [4, 5]],
      ['verifier', [2, 5]],
    ]);
  });

  test('unaddressedSince acha resultados que foram para ninguém', () => {
    assert.deepEqual(unaddressedSince(members, posts, 0).map((p) => p.seq), [3]);
    assert.deepEqual(unaddressedSince(members, posts, 3), []);
  });
});

describe('grupos numerados', () => {
  test('numberedCopies gera nome-1..k e valida o comprimento final', () => {
    assert.deepEqual(numberedCopies('fix', 3), ['fix-1', 'fix-2', 'fix-3']);
    assert.deepEqual(numberedCopies('solo', 1), ['solo']);
    assert.throws(() => numberedCopies('x'.repeat(23), 2), SwarmError);
    assert.throws(() => numberedCopies('fix', 0), /n/);
  });

  test('groupMembers devolve o membro exato ou o grupo numerado', () => {
    const members = { 'fix-1': {}, 'fix-2': {}, fixer: {} };
    assert.deepEqual(groupMembers('fix', members), ['fix-1', 'fix-2']);
    assert.deepEqual(groupMembers('fixer', members), ['fixer']);
    assert.deepEqual(groupMembers('nada', members), []);
  });
});

describe('formatação', () => {
  test('formatPost mostra seq, hora local, autor e texto', () => {
    const line = formatPost(post(7, 'parser', '@coordinator [done] ok'));
    assert.match(line, /^#7 \[\d{2}:\d{2}\] parser: @coordinator \[done\] ok$/);
  });

  test('workerPrompt traz tarefa, comandos do board e a quem reportar', () => {
    const p = workerPrompt({
      name: 'parser', role: 'worker', title: 'reescrita', dir: 'C:/x/swarm/abc',
      script: 'C:/s/board.mjs', brief: 'Você é dono de src/parser.js.', reportTo: 'coordinator',
      workspacePath: null,
    });
    assert.match(p, /Você acabou de começar\. Sua tarefa \(@parser/);
    assert.match(p, /Você é dono de src\/parser\.js\./);
    assert.match(p, /node "C:\/s\/board\.mjs" --dir "C:\/x\/swarm\/abc" read --for parser/);
    assert.match(p, /post --as parser/);
    assert.match(p, /@coordinator/);
    assert.match(p, /mesmo diretório do coordinator/);
  });

  test('workerPrompt com workspace próprio manda usar caminhos absolutos dele', () => {
    const p = workerPrompt({
      name: 'ui', role: 'worker', title: 't', dir: '/d', script: '/s.mjs', brief: 'b',
      reportTo: 'parser', workspacePath: '/d/wt/ui',
    });
    assert.match(p, /\/d\/wt\/ui/);
    assert.match(p, /@parser/);
  });
});
