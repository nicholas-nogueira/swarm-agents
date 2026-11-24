import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScope, resolveClients, SCOPES } from '../../installer/validate.mjs';
import { InstallerError, EXIT } from '../../installer/errors.mjs';
import { fakeAdapter } from './helpers.mjs';

const adapters = [fakeAdapter('claude'), fakeAdapter('codex'), fakeAdapter('antigravity', { defaultSelected: false })];

test('SCOPES é a lista fechada user/project', () => {
  assert.deepEqual([...SCOPES], ['user', 'project']);
  assert.ok(Object.isFrozen(SCOPES));
});

test('validateScope aceita user e project e usa user como padrão', () => {
  assert.equal(validateScope('user'), 'user');
  assert.equal(validateScope('project'), 'project');
  assert.equal(validateScope(undefined), 'user');
});

test('validateScope recusa valor fora da lista com mensagem amigável', () => {
  for (const bad of ['global', '', '../user', 'USER']) {
    assert.throws(() => validateScope(bad), (err) => {
      assert.ok(err instanceof InstallerError);
      assert.equal(err.code, 'ESCOPO_INVALIDO');
      assert.equal(err.exitCode, EXIT.ERROR);
      assert.match(err.message, /user ou project/);
      return true;
    });
  }
});

test('resolveClients devolve os adapters na ordem pedida, sem repetição', () => {
  const out = resolveClients(['codex', 'claude', 'codex'], adapters);
  assert.deepEqual(out.map((a) => a.id), ['codex', 'claude']);
});

test('resolveClients recusa id desconhecido listando os válidos', () => {
  assert.throws(() => resolveClients(['vim'], adapters), (err) => {
    assert.equal(err.code, 'CLIENTE_DESCONHECIDO');
    assert.match(err.message, /"vim"/);
    assert.match(err.message, /claude, codex, antigravity/);
    return true;
  });
});

test('resolveClients recusa id com caracteres suspeitos sem ecoar o valor inteiro', () => {
  const evil = `../../${'x'.repeat(200)}`;
  assert.throws(() => resolveClients([evil], adapters), (err) => {
    assert.equal(err.code, 'CLIENTE_DESCONHECIDO');
    assert.ok(err.message.length < 300);
    return true;
  });
});

test('resolveClients recusa lista vazia', () => {
  assert.throws(() => resolveClients([], adapters), { code: 'NENHUM_CLIENTE' });
});
