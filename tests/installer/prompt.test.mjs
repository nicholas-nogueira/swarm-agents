import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrompter } from '../../installer/prompt.mjs';
import { captureStream, inputFrom } from './helpers.mjs';

const items = [
  { id: 'claude', label: 'Claude Code', hint: 'detectado' },
  { id: 'codex', label: 'Codex', hint: 'não detectado' },
  { id: 'antigravity', label: 'Antigravity', hint: 'já tem /swarm nativo' },
];

test('multiselect: Enter direto mantém a pré-seleção', async () => {
  const output = captureStream();
  const p = createPrompter({ input: inputFrom(['']), output });
  assert.deepEqual(await p.multiselect('Onde instalar?', items, ['claude']), ['claude']);
  p.close();
  const text = output.text();
  assert.match(text, /1\) \[x\] Claude Code \(detectado\)/);
  assert.match(text, /3\) \[ \] Antigravity/);
});

test('multiselect: números alternam a marcação até o Enter', async () => {
  const output = captureStream();
  const p = createPrompter({ input: inputFrom(['2 3', '1,3', '']), output });
  assert.deepEqual(await p.multiselect('Onde instalar?', items, ['claude']), ['codex']);
  p.close();
});

test('multiselect: entrada inválida mostra aviso e pergunta de novo', async () => {
  const output = captureStream();
  const p = createPrompter({ input: inputFrom(['9', 'abc', '2', '']), output });
  assert.deepEqual(await p.multiselect('Onde instalar?', items, []), ['codex']);
  p.close();
  assert.match(output.text(), /Opção inválida/);
});

test('multiselect: "todos" e "nenhum"', async () => {
  const p = createPrompter({ input: inputFrom(['todos', '']), output: captureStream() });
  assert.deepEqual(await p.multiselect('?', items, []), ['claude', 'codex', 'antigravity']);
  p.close();
  const q = createPrompter({ input: inputFrom(['nenhum', '']), output: captureStream() });
  assert.deepEqual(await q.multiselect('?', items, ['claude']), []);
  q.close();
});

test('multiselect: fim da entrada (Ctrl+D) cancela', async () => {
  const p = createPrompter({ input: inputFrom([]), output: captureStream() });
  await assert.rejects(p.multiselect('?', items, []), { code: 'CANCELADO' });
  p.close();
});

test('choose: padrão no Enter, número ou nome, e repete em inválido', async () => {
  const opts = [{ id: 'user', label: 'usuário' }, { id: 'project', label: 'projeto' }];
  const out = captureStream();
  const p = createPrompter({ input: inputFrom(['', '2', 'x', 'user']), output: out });
  assert.equal(await p.choose('Escopo?', opts, 'user'), 'user');
  assert.equal(await p.choose('Escopo?', opts, 'user'), 'project');
  assert.equal(await p.choose('Escopo?', opts, 'user'), 'user');
  p.close();
  assert.match(out.text(), /Opção inválida/);
});

test('confirm: s/sim confirma, n/Enter nega (padrão não), EOF cancela', async () => {
  const p = createPrompter({ input: inputFrom(['s', 'SIM', 'n', '', 'talvez', 'y']), output: captureStream() });
  assert.equal(await p.confirm('Aplicar?'), true);
  assert.equal(await p.confirm('Aplicar?'), true);
  assert.equal(await p.confirm('Aplicar?'), false);
  assert.equal(await p.confirm('Aplicar?'), false);
  assert.equal(await p.confirm('Aplicar?'), true);
  await assert.rejects(p.confirm('Aplicar?'), { code: 'CANCELADO' });
  p.close();
});
