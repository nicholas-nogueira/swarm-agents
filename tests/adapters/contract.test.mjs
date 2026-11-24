// Contrato de adapters/index.mjs: todo adapter segue a mesma forma, valida entradas e gera arquivos seguros.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative, isAbsolute } from 'node:path';
import { ADAPTERS, listAdapters, getAdapter } from '../../adapters/index.mjs';
import { AdapterError } from '../../adapters/lib/errors.mjs';
import { mockPayload, ctxFor, makeTmp, writeTree, textOfFile, posix, RAIZ } from './helpers.mjs';

const IDS = ['claude', 'codex', 'cursor', 'opencode', 'gemini', 'antigravity'];
const VERIFIED = new Set(['native-claude', 'local', 'doc']);

// Marcadores mínimos (arquivo/pasta que a ferramenta cria no HOME) para o teste de detect.
const MARCADORES = {
  claude: { '.claude/settings.json': '{}' },
  codex: { '.codex/config.toml': '' },
  cursor: { '.cursor/skills/x/SKILL.md': 'x' },
  opencode: { '.config/opencode/opencode.jsonc': '{}' },
  gemini: { '.gemini/settings.json': '{}' },
  antigravity: { '.gemini/antigravity/x.txt': 'x' },
};


test('ADAPTERS tem exatamente as 6 ferramentas e listAdapters devolve na mesma ordem', () => {
  assert.deepEqual(Object.keys(ADAPTERS), IDS);
  assert.deepEqual(listAdapters().map((a) => a.id), IDS);
  assert.ok(Object.isFrozen(ADAPTERS));
});

test('getAdapter devolve o adapter e recusa id desconhecido ou perigoso', () => {
  assert.equal(getAdapter('cursor'), ADAPTERS.cursor);
  for (const bad of ['', 'copilot', '__proto__', 'constructor', '../claude', undefined]) {
    assert.throws(() => getAdapter(bad), (e) => {
      assert.ok(e instanceof AdapterError);
      assert.equal(e.code, 'FERRAMENTA_DESCONHECIDA');
      assert.match(e.message, /claude, codex, cursor, opencode, gemini, antigravity/);
      return true;
    });
  }
});

for (const a of listAdapters()) {
  test(`[${a.id}] forma do adapter: id, name, defaultSelected, verified, notes, detect, plan`, () => {
    assert.equal(typeof a.id, 'string');
    assert.ok(a.name.length > 0);
    assert.equal(typeof a.defaultSelected, 'boolean');
    assert.ok(VERIFIED.has(a.verified), `verified inválido: ${a.verified}`);
    assert.ok(Array.isArray(a.notes) && a.notes.every((n) => typeof n === 'string'));
    assert.equal(typeof a.detect, 'function');
    assert.equal(typeof a.plan, 'function');
    assert.ok(Object.isFrozen(a));
  });

  test(`[${a.id}] detect: falso em home vazia e sem entrada, verdadeiro com a pasta da ferramenta`, async (t) => {
    const tmp = await makeTmp();
    t.after(tmp.cleanup);
    const ctx = { home: join(tmp.dir, 'home'), cwd: join(tmp.dir, 'cwd'), env: {} };
    assert.equal(a.detect(ctx), false);
    assert.equal(a.detect({}), false);
    assert.equal(a.detect({ home: 'relativo', cwd: 'x', env: {} }), false);
    await writeTree(ctx.home, MARCADORES[a.id]);
    assert.equal(a.detect(ctx), true);
  });

  for (const scope of ['user', 'project']) {
    test(`[${a.id}] plan(${scope}): caminhos absolutos, únicos, dentro do destino e conteúdo não vazio`, async (t) => {
      const tmp = await makeTmp();
      t.after(tmp.cleanup);
      const ctx = ctxFor(tmp.dir, scope);
      const plan = a.plan(ctx);
      assert.ok(plan.files.length >= 8, 'skill inteira + 2 agentes');
      const base = scope === 'user' ? ctx.home : ctx.cwd;
      const paths = plan.files.map((f) => f.path);
      assert.equal(new Set(paths).size, paths.length, 'caminhos duplicados');
      for (const f of plan.files) {
        assert.ok(isAbsolute(f.path), `não absoluto: ${f.path}`);
        const rel = relative(base, f.path);
        assert.ok(!rel.startsWith('..') && !isAbsolute(rel), `fora do destino (${scope}): ${f.path}`);
        assert.ok(typeof f.content === 'string' || Buffer.isBuffer(f.content));
        assert.ok(f.content.length > 0, `vazio: ${f.path}`);
      }
      assert.ok(plan.notes.every((n) => typeof n === 'string'));
      assert.ok(plan.notes.length > 0, 'todo plano explica onde instalou');
    });
  }

  test(`[${a.id}] plan é idempotente: duas chamadas dão exatamente os mesmos bytes`, async (t) => {
    const tmp = await makeTmp();
    t.after(tmp.cleanup);
    const ctx = ctxFor(tmp.dir);
    const um = a.plan(ctx);
    const dois = a.plan(ctx);
    assert.deepEqual(um.files.map((f) => f.path), dois.files.map((f) => f.path));
    um.files.forEach((f, i) => assert.ok(Buffer.from(f.content).equals(Buffer.from(dois.files[i].content))));
  });

  test(`[${a.id}] plan recusa escopo inválido, payload incompleto e caminhos relativos`, async (t) => {
    const tmp = await makeTmp();
    t.after(tmp.cleanup);
    const ctx = ctxFor(tmp.dir);
    assert.throws(() => a.plan({ ...ctx, scope: 'global' }), { code: 'ESCOPO_INVALIDO' });
    assert.throws(() => a.plan({ ...ctx, scope: undefined }), { code: 'ESCOPO_INVALIDO' });
    assert.throws(() => a.plan({ ...ctx, payload: new Map() }), { code: 'PAYLOAD_INCOMPLETO' });
    assert.throws(() => a.plan({ ...ctx, payload: null }), { code: 'PAYLOAD_INCOMPLETO' });
    const semVerifier = mockPayload({ 'agents/swarm-verifier.md': null });
    assert.throws(() => a.plan({ ...ctx, payload: semVerifier }), { code: 'PAYLOAD_INCOMPLETO' });
    assert.throws(() => a.plan({ ...ctx, home: 'relativo' }), { code: 'CAMINHO_INVALIDO' });
    assert.throws(() => a.plan({ ...ctx, scope: 'project', cwd: 'relativo' }), { code: 'CAMINHO_INVALIDO' });
  });

  test(`[${a.id}] plan não carrega o segredo do usuário nem caminhos de configuração das ferramentas`, async (t) => {
    const tmp = await makeTmp();
    t.after(tmp.cleanup);
    for (const f of a.plan(ctxFor(tmp.dir)).files) {
      const p = posix(f.path);
      assert.doesNotMatch(p, /mcp\.json|settings\.json|config\.toml|opencode\.jsonc?$|mcp_config\.json|hooks\.json/, p);
    }
  });
}

test('os adapters não-Claude nunca deixam variáveis do Claude Code nem injeção por ! em nenhum arquivo de texto', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  for (const a of listAdapters().filter((x) => x.id !== 'claude')) {
    for (const scope of ['user', 'project']) {
      for (const f of a.plan(ctxFor(tmp.dir, scope)).files) {
        const txt = textOfFile(f);
        assert.doesNotMatch(txt, /CLAUDE_SKILL_DIR/, `${a.id}: ${f.path}`);
        assert.doesNotMatch(txt, /CLAUDE_SESSION_ID/, `${a.id}: ${f.path}`);
        assert.doesNotMatch(txt, /^!`/m, `${a.id}: ${f.path}`);
      }
    }
  }
});

test('nenhum par de adapters planeja o mesmo arquivo (o instalador recusa destino duplicado)', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  for (const scope of ['user', 'project']) {
    const vistos = new Map();
    for (const a of listAdapters()) {
      for (const f of a.plan(ctxFor(tmp.dir, scope)).files) {
        assert.ok(!vistos.has(f.path), `${a.id} e ${vistos.get(f.path)} planejam ${f.path}`);
        vistos.set(f.path, a.id);
      }
    }
  }
});

test('o plano nunca vaza o caminho real do HOME do usuário nem segredos: só os caminhos recebidos aparecem', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const ctx = ctxFor(tmp.dir);
  for (const a of listAdapters().filter((x) => x.id !== 'claude')) {
    for (const f of a.plan(ctx).files) {
      const txt = textOfFile(f);
      assert.doesNotMatch(txt, /PLAYWRIGHT_MCP_EXTENSION_TOKEN|Nicholas/i, `${a.id}: ${f.path}`);
    }
  }
});

// ---------- reads: pastas que a ferramenta carrega ----------
const dentro = (pasta, arquivo) => {
  const rel = relative(pasta, arquivo);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

for (const a of listAdapters()) {
  for (const scope of ['user', 'project']) {
    test(`[${a.id}] reads (${scope}): absolutos, únicos, ordenados e cobrem tudo o que o próprio plano grava`, async (t) => {
      const tmp = await makeTmp();
      t.after(tmp.cleanup);
      const plan = a.plan(ctxFor(tmp.dir, scope));
      assert.ok(Array.isArray(plan.reads) && plan.reads.length > 0);
      assert.ok(plan.reads.every((p) => isAbsolute(p)));
      assert.equal(new Set(plan.reads).size, plan.reads.length);
      assert.deepEqual(plan.reads, [...plan.reads].sort());
      for (const f of plan.files) {
        assert.ok(plan.reads.some((r) => dentro(r, f.path)), `${a.id}: ${f.path} não está numa pasta que a ferramenta lê`);
      }
    });
  }
}

test('reads: o que o harness-docs.md diz que cada ferramenta lê (inclui as pastas compartilhadas)', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const ctx = ctxFor(tmp.dir);
  const reads = (id) => ADAPTERS[id].plan(ctx).reads.map((p) => posix(relative(tmp.dir, p)));
  const tem = (id, ...pastas) => pastas.forEach((p) => assert.ok(reads(id).includes(p), `${id} deveria ler ${p}; lê ${reads(id).join(', ')}`));
  tem('codex', 'home/.agents/skills', 'home/.codex/agents', 'projeto/.agents/skills', 'projeto/.codex/agents');
  tem('cursor', 'home/.agents/skills', 'home/.claude/skills', 'home/.claude/agents', 'home/.cursor/skills', 'home/.codex/skills', 'projeto/.claude/skills');
  tem('opencode', 'home/.agents/skills', 'home/.claude/skills', 'home/.config/opencode/skills', 'projeto/.opencode/skills');
  tem('gemini', 'home/.agents/skills', 'home/.gemini/skills', 'projeto/.gemini/skills', 'projeto/.agents/skills');
  tem('antigravity', 'home/.gemini/config/skills', 'home/.gemini/skills', 'home/.gemini/antigravity-cli/skills', 'projeto/.agents/skills');
  tem('claude', 'home/.claude/skills', 'home/.claude/agents', 'projeto/.claude/skills');
});

test('reads: sem cwd absoluto só as pastas de user entram (project não é inventado)', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const ctx = { ...ctxFor(tmp.dir), cwd: undefined };
  const reads = ADAPTERS.cursor.plan(ctx).reads;
  assert.ok(reads.length > 0 && reads.every((p) => dentro(ctx.home, p)));
});

test('os adapters que leem ~/.agents/skills avisam nas notes da pasta compartilhada (qual vence: não verificado)', () => {
  for (const id of ['codex', 'cursor', 'opencode', 'gemini']) {
    const notes = ADAPTERS[id].notes.join('\n');
    assert.match(notes, /~\/\.agents\/skills/, id);
    assert.match(notes, /qual vence: não verificado/, id);
  }
  assert.match(ADAPTERS.opencode.notes.join('\n'), /~\/\.claude\/skills/);
  assert.match(ADAPTERS.cursor.notes.join('\n'), /~\/\.claude\/skills/);
});

test('antigravity registra a divergência de nomes de tools nas notes e no README, sem afirmar qual vale', async () => {
  const notes = ADAPTERS.antigravity.notes.join('\n');
  assert.match(notes, /view_file/);
  assert.match(notes, /read_file/);
  assert.match(notes, /Não afirmamos qual vale/);
  const readme = await (await import('node:fs/promises')).readFile(join(RAIZ, 'adapters', 'README.md'), 'utf8');
  assert.match(readme, /view_file/);
  assert.match(readme, /não afirmamos qual vale/);
});

// ---------- path traversal nas chaves do payload ----------
const CHAVES_RUINS = {
  'sobe com .. dentro do HOME': 'skills/swarm/../../../.bashrc',
  'sobe com .. para fora do HOME': 'skills/swarm/../../../../evil.txt',
  '.. em agents': 'agents/../../x.md',
  'raiz absoluta': '/etc/passwd',
  'letra de unidade': 'C:/Windows/x.txt',
  'barra invertida': 'skills\\swarm\\x.txt',
  'segmento vazio': 'skills/swarm//x.txt',
  'segmento ponto': 'skills/swarm/./x.txt',
  'byte nulo': 'skills/swarm/a\u0000b',
  'chave vazia': '',
};

for (const a of listAdapters()) {
  for (const [caso, chave] of Object.entries(CHAVES_RUINS)) {
    test(`[${a.id}] recusa chave de payload insegura: ${caso}`, async (t) => {
      const tmp = await makeTmp();
      t.after(tmp.cleanup);
      const payload = mockPayload();
      payload.set(chave, Buffer.from('x'));
      assert.throws(() => a.plan(ctxFor(tmp.dir, 'user', payload)), (e) => {
        assert.ok(e instanceof AdapterError);
        assert.equal(e.code, 'PAYLOAD_INCOMPATIVEL');
        assert.match(e.message, /caminho inseguro/);
        assert.match(e.message, /Nada foi gravado/);
        return true;
      });
    });
  }
}
