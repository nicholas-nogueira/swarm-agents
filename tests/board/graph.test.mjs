import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph } from '../../payload/skills/swarm/scripts/lib/board-core.mjs';
import { renderHtml, HTML_FILE } from '../../payload/skills/swarm/scripts/lib/html.mjs';
import { tempDir, cleanup, run } from './helpers.mjs';

const members = {
  coordinator: { role: 'coordinator', state: 'working' },
  slug: { role: 'worker', state: 'waiting' },
  money: { role: 'worker', state: 'waiting' },
  verifier: { role: 'verifier', state: 'killed' },
};
const p = (seq, agent, mentions, extra = {}) => ({ seq, agent, text: `t${seq}`, time: '2026-11-19T10:00:00Z', mentions, ...extra });
const posts = [
  p(1, 'coordinator', ['slug'], { kind: 'brief' }),
  p(2, 'slug', ['verifier']),
  p(3, 'money', ['verifier']),
  p(4, 'verifier', ['money']),
  p(5, 'money', ['verifier']),
  p(6, 'coordinator', ['all']),
  p(7, 'slug', []),
];

describe('buildGraph', () => {
  test('agrega arestas autor → mencionado com contagem e seqs', () => {
    const g = buildGraph(members, posts);
    const e = g.edges.find((x) => x.from === 'money' && x.to === 'verifier');
    assert.equal(e.count, 2);
    assert.deepEqual(e.seqs, [3, 5]);
  });

  test('@all vira uma aresta para cada membro vivo, menos o autor', () => {
    const g = buildGraph(members, posts);
    const fromAll = g.edges.filter((x) => x.seqs.includes(6)).map((x) => x.to).sort();
    assert.deepEqual(fromAll, ['money', 'slug']);
  });

  test('brief vira aresta marcada; post sem @ não vira aresta', () => {
    const g = buildGraph(members, posts);
    assert.equal(g.edges.find((x) => x.from === 'coordinator' && x.to === 'slug').briefs, 1);
    assert.equal(g.edges.some((x) => x.seqs.includes(7)), false);
  });

  test('upTo limita o grafo ao replay até aquele #seq', () => {
    const g = buildGraph(members, posts, 3);
    assert.equal(g.edges.reduce((n, e) => n + e.count, 0), 3);
    assert.equal(g.nodes.find((n) => n.name === 'money').posts, 1);
  });

  test('nós trazem papel, estado e posts enviados', () => {
    const g = buildGraph(members, posts);
    const v = g.nodes.find((n) => n.name === 'verifier');
    assert.deepEqual([v.role, v.state, v.posts], ['verifier', 'killed', 1]);
  });

  test('funciona sem posts e sem membros', () => {
    assert.deepEqual(buildGraph({}, []), { nodes: [], edges: [] });
  });
});

describe('renderHtml', () => {
  const roster = { title: 'teste <b>', backend: 'subagents', members };

  test('embute os dados e a mesma função buildGraph usada nos testes', () => {
    const html = renderHtml({ roster, posts, generatedAt: '2026-11-19T10:00:00Z' });
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /function buildGraph/);
    assert.match(html, /"seq":7/);
  });

  test('neutraliza </script> e HTML vindos de posts (dados não confiáveis)', () => {
    const evil = [p(1, 'slug', [], { text: '</script><script>alert(1)</script>' })];
    const html = renderHtml({ roster, posts: evil, generatedAt: 'x' });
    assert.equal(html.includes('</script><script>alert(1)'), false);
    assert.equal(html.includes('<b>'), false, 'o título também é escapado');
  });

  test('marca o swarm como encerrado depois do [done] do coordinator', () => {
    const done = [...posts, p(8, 'coordinator', [], { text: '[done] tudo certo' })];
    assert.match(renderHtml({ roster, posts: done, generatedAt: 'x' }), /"finished":true/);
    assert.match(renderHtml({ roster, posts, generatedAt: 'x' }), /"finished":false/);
  });
});

describe('board.html regerado a cada escrita', () => {
  let root;
  let dir;
  beforeEach(async () => {
    root = tempDir();
    dir = join(root, 's');
    await run(['--dir', dir, 'init', '--title', 'g']);
  });
  afterEach(() => cleanup(root));

  test('init, member add e post atualizam o board.html', async () => {
    const file = join(dir, HTML_FILE);
    assert.ok(existsSync(file));
    await run(['--dir', dir, 'member', 'add', '--name', 'slug', '--brief', 'b']);
    await run(['--dir', dir, 'post', '--as', 'slug', '--text', '@coordinator oi']);
    assert.match(readFileSync(file, 'utf8'), /"seq":2/);
  });

  test('o comando html regera e imprime a URL file:///', async () => {
    const r = await run(['--dir', dir, 'html']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^file:\/\/\/.*board\.html$/m);
  });

  test('html --open respeita SWARM_NO_OPEN (os testes nunca abrem o navegador)', async () => {
    const r = await run(['--dir', dir, 'html', '--open'], { env: { SWARM_NO_OPEN: '1' } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Navegador não aberto/);
  });

  test('render e status mostram onde está o grafo', async () => {
    assert.match((await run(['--dir', dir, 'render'])).out, /board\.html/);
    assert.match((await run(['--dir', dir, 'status'])).out, /board\.html/);
  });
});
