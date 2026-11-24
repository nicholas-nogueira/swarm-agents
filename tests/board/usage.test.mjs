import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseUsage, priceOf, costOf, emptyTotals, addTo, shortModel, loadModels, resolveModel, collectUsage,
} from '../../payload/skills/swarm/scripts/lib/usage.mjs';
import { renderHtml } from '../../payload/skills/swarm/scripts/lib/html.mjs';
import { tempDir, cleanup, run } from './helpers.mjs';

const usage = (o = {}) => ({
  input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200,
  cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 }, speed: 'standard', ...o,
});
const line = (id, model, u = usage(), ts = '2026-11-19T12:00:00Z', effort = 'medium') => `${JSON.stringify({ type: 'assistant', timestamp: ts, effort, message: { id, model, usage: u } })}\n`;

describe('parseUsage', () => {
  test('soma por modelo e ignora as linhas repetidas da mesma mensagem', () => {
    const text = line('m1', 'claude-opus-5-5') + line('m1', 'claude-opus-5-5') + line('m2', 'claude-opus-5-5');
    const r = parseUsage(text);
    assert.equal(r.messages, 2);
    assert.deepEqual(r.byModel['claude-opus-5-5'], { input: 20, output: 200, cacheRead: 2000, cacheWrite5m: 400, cacheWrite1h: 0, fastOutput: 0, fastInput: 0, messages: 2 });
  });

  test('conta o effort de cada mensagem e guarda o último', () => {
    const text = line('m1', 'x', usage(), undefined, 'xhigh') + line('m2', 'x', usage(), undefined, 'medium') + line('m3', 'x', usage(), undefined, 'medium');
    const r = parseUsage(text);
    assert.deepEqual(r.efforts, { xhigh: 1, medium: 2 });
    assert.equal(r.lastEffort, 'medium');
  });

  test('since descarta mensagens anteriores (consumo do coordinator antes do swarm)', () => {
    const text = line('m1', 'claude-opus-5-5', usage(), '2026-11-19T10:00:00Z') + line('m2', 'claude-opus-5-5', usage(), '2026-11-19T12:00:00Z');
    assert.equal(parseUsage(text, { since: '2026-11-19T11:00:00Z' }).messages, 1);
  });

  test('ignora linha corrompida, linha sem usage e linha sintética', () => {
    const text = 'nao-json\n{"type":"user"}\n' + line('m1', '<synthetic>') + line('m2', 'claude-sonnet-5-5');
    const r = parseUsage(text);
    assert.deepEqual(Object.keys(r.byModel), ['claude-sonnet-5-5']);
  });

  test('cache de 1 h e modo rápido são separados', () => {
    const u = usage({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 }, speed: 'fast' });
    const t = parseUsage(line('m1', 'claude-opus-5-5', u)).byModel['claude-opus-5-5'];
    assert.equal(t.cacheWrite1h, 200);
    assert.equal(t.fastOutput, 100);
  });

  test('sem cache_creation detalhado, a escrita conta como 5 min', () => {
    const u = usage({ cache_creation: undefined });
    assert.equal(parseUsage(line('m1', 'x', u)).byModel.x.cacheWrite5m, 200);
  });
});

describe('preço e custo', () => {
  const models = loadModels();

  test('models.json traz os 4 modelos atuais com os preços oficiais', () => {
    assert.deepEqual(priceOf(models, 'claude-opus-5-5'), { input: 4, output: 20, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, fast_multiplier: 2 });
    for (const id of ['claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5']) assert.ok(priceOf(models, id), id);
  });

  test('custo = soma de cada tipo de token pelo preço por milhão', () => {
    const t = { ...emptyTotals(), input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
    assert.ok(Math.abs(costOf(models, 'claude-opus-5-5', t) - 37.2) < 1e-9);
  });

  test('modo rápido cobra o multiplicador sobre entrada e saída', () => {
    const t = { ...emptyTotals(), output: 1e6, fastOutput: 1e6 };
    assert.equal(costOf(models, 'claude-opus-5-5', t), 40);
  });

  test('modelo sem preço conhecido tem custo null (não inventa número)', () => {
    assert.equal(costOf(models, 'claude-desconhecido', { ...emptyTotals(), input: 5 }), null);
  });

  test('addTo acumula totais; shortModel encurta o id', () => {
    const a = emptyTotals();
    addTo(a, { ...emptyTotals(), input: 3, messages: 1 });
    addTo(a, { ...emptyTotals(), input: 4, messages: 1 });
    assert.equal(a.input, 7);
    assert.equal(shortModel('claude-sonnet-5-5'), 'sonnet-5-5');
  });
});

describe('resolveModel (modelo por atividade)', () => {
  const models = loadModels();
  test('o tier escolhe o modelo recomendado', () => {
    assert.deepEqual(resolveModel(models, { tier: 'mecanico' }), { tier: 'mecanico', model: 'haiku', effort: 'low' });
    assert.equal(resolveModel(models, { tier: 'complexo' }).model, 'opus');
  });
  test('--model explícito vence o tier', () => {
    assert.deepEqual(resolveModel(models, { tier: 'mecanico', model: 'sonnet', effort: 'high' }), { tier: 'mecanico', model: 'sonnet', effort: 'high' });
  });
  test('sem tier nem model, herda', () => {
    assert.deepEqual(resolveModel(models, {}), { tier: null, model: 'inherit', effort: null });
  });
  test('tier ou modelo inválido dão erro amigável', () => {
    assert.throws(() => resolveModel(models, { tier: 'turbo' }), /--tier.*complexo/);
    assert.throws(() => resolveModel(models, { model: 'gpt' }), /--model.*sonnet/);
    assert.throws(() => resolveModel(models, { effort: 'turbo' }), /--effort.*xhigh/);
  });
});

describe('collectUsage (transcrições reais do Claude Code)', () => {
  let root;
  let projects;
  let dir;
  const session = 'sess-1';
  beforeEach(() => {
    root = tempDir();
    projects = join(root, 'projects');
    const proj = join(projects, 'C--proj');
    mkdirSync(join(proj, session, 'subagents'), { recursive: true });
    writeFileSync(join(proj, `${session}.jsonl`), line('c0', 'claude-opus-5-5', usage(), '2026-11-19T09:00:00Z') + line('c1', 'claude-opus-5-5'));
    writeFileSync(join(proj, session, 'subagents', 'agent-abc.jsonl'), line('w1', 'claude-sonnet-5-5') + line('w1', 'claude-sonnet-5-5'));
    dir = join(root, 'swarm', session);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => cleanup(root));

  const roster = () => ({
    created_at: '2026-11-19T11:00:00Z',
    members: {
      coordinator: { role: 'coordinator', state: 'working' },
      slug: { role: 'worker', state: 'working', agent_id: 'abc', model: 'sonnet', tier: 'implementacao' },
      money: { role: 'worker', state: 'working', agent_id: null },
    },
  });

  test('por agente: coordinator só depois do init, worker pelo agent_id, sem id = sem dados', async () => {
    const u = await collectUsage(dir, roster(), { SWARM_PROJECTS_DIR: projects });
    assert.equal(u.members.coordinator.tokens.messages, 1);
    assert.deepEqual(u.members.slug.models, ['claude-sonnet-5-5']);
    assert.equal(u.members.slug.lastEffort, 'medium');
    assert.equal(u.members.slug.tokens.messages, 1);
    assert.equal(u.members.money, undefined);
    assert.ok(u.total.cost > 0);
    assert.deepEqual(Object.keys(u.byModel).sort(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  });

  test('leitura incremental: só o que foi anexado é lido de novo, e o total continua certo', async () => {
    const env = { SWARM_PROJECTS_DIR: projects };
    await collectUsage(dir, roster(), env);
    const cache = JSON.parse(readFileSync(join(dir, 'usage-cache.json'), 'utf8'));
    assert.ok(Object.values(cache.files).every((f) => f.offset > 0));
    const f = join(projects, 'C--proj', session, 'subagents', 'agent-abc.jsonl');
    appendFileSync(f, line('w1', 'claude-sonnet-5-5') + line('w2', 'claude-sonnet-5-5') + '{"parcial":');
    const u = await collectUsage(dir, roster(), env);
    assert.equal(u.members.slug.tokens.messages, 2, 'w1 repetido na fronteira não conta de novo; linha parcial espera');
  });

  test('cache corrompido é descartado sem quebrar', async () => {
    writeFileSync(join(dir, 'usage-cache.json'), '{quebrado');
    const u = await collectUsage(dir, roster(), { SWARM_PROJECTS_DIR: projects });
    assert.equal(u.members.slug.tokens.messages, 1);
  });

  test('sem transcrições (outra máquina, --dir avulso) devolve vazio', async () => {
    const u = await collectUsage(join(root, 'outro'), roster(), { SWARM_PROJECTS_DIR: join(root, 'nada') });
    assert.deepEqual(u.members, {});
    assert.equal(u.total.cost, 0);
  });

  test('o board.html embute o consumo', async () => {
    const u = await collectUsage(dir, roster(), { SWARM_PROJECTS_DIR: projects });
    const html = renderHtml({ roster: { title: 't', backend: 'b', members: roster().members }, posts: [], generatedAt: 'x', usage: u });
    assert.match(html, /"claude-sonnet-5-5"/);
    assert.match(html, /estimativa/i);
  });
});

describe('CLI: --tier/--model, usage e models', () => {
  let root;
  let dir;
  beforeEach(async () => {
    root = tempDir();
    dir = join(root, 's');
    await run(['--dir', dir, 'init', '--title', 'm']);
  });
  afterEach(() => cleanup(root));

  test('member add --tier grava o modelo e o prompt avisa qual passar ao Agent', async () => {
    const r = await run(['--dir', dir, 'member', 'add', '--name', 'docs', '--tier', 'mecanico', '--brief', 'b']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /model: "haiku", effort: "low"/);
    const m = JSON.parse(readFileSync(join(dir, 'members.json'), 'utf8')).members.docs;
    assert.deepEqual([m.model, m.tier, m.effort], ['haiku', 'mecanico', 'low']);
  });

  test('member add sem tier herda e não imprime aviso de modelo', async () => {
    const r = await run(['--dir', dir, 'member', 'add', '--name', 'docs', '--brief', 'b']);
    assert.doesNotMatch(r.err, /model:/);
  });

  test('tier inválido falha antes de criar o membro', async () => {
    const r = await run(['--dir', dir, 'member', 'add', '--name', 'docs', '--tier', 'turbo', '--brief', 'b']);
    assert.equal(r.code, 2);
    assert.match(r.err, /--tier/);
  });

  test('usage mostra tabela e --json; models lista os tiers', async () => {
    const env = { SWARM_PROJECTS_DIR: join(root, 'vazio') };
    assert.match((await run(['--dir', dir, 'usage'], { env })).out, /Total do swarm/);
    assert.equal(JSON.parse((await run(['--dir', dir, 'usage', '--json'], { env })).out).total.cost, 0);
    const m = (await run(['--dir', dir, 'models'])).out;
    assert.match(m, /mecanico.*haiku/);
    assert.match(m, /claude-opus-5-5/);
  });
});
