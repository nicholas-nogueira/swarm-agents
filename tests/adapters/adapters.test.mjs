// Testes funcionais de cada adapter: caminhos por escopo, formato dos arquivos gerados e conteúdo adaptado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ADAPTERS } from '../../adapters/index.mjs';
import { parseFrontmatter } from '../../adapters/lib/frontmatter.mjs';
import { mockPayload, ctxFor, makeTmp, writeTree, findFile, textOfFile, posix, MOCK_SKILL, MOCK_WORKER } from './helpers.mjs';

const tmpCtx = async (t, scope = 'user', payload = mockPayload()) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  return ctxFor(tmp.dir, scope, payload);
};

const skillOf = (plan, rel) => textOfFile(findFile(plan, rel));

// ---------------------------------------------------------------- claude
test('claude: metadados e detecção por ~/.claude', async (t) => {
  const a = ADAPTERS.claude;
  assert.equal(a.verified, 'native-claude');
  assert.equal(a.defaultSelected, true);
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, { 'h/.claude/x': '1' });
  assert.equal(a.detect({ home: join(tmp.dir, 'h'), env: {} }), true);
  assert.equal(a.detect({ home: join(tmp.dir, 'h'), cwd: tmp.dir, env: { CLAUDE_CONFIG_DIR: join(tmp.dir, 'nao') } }), true);
});

test('claude: identidade, cada arquivo do payload vai para o mesmo lugar do ~/.claude, byte a byte', async (t) => {
  const ctx = await tmpCtx(t);
  const plan = ADAPTERS.claude.plan(ctx);
  assert.equal(plan.files.length, ctx.payload.size);
  for (const [rel, buf] of ctx.payload) {
    const f = findFile(plan, `/.claude/${rel}`);
    assert.equal(f.path, join(ctx.home, '.claude', ...rel.split('/')));
    assert.ok(Buffer.isBuffer(f.content) && f.content.equals(buf), `conteúdo alterado: ${rel}`);
  }
});

test('claude: escopo project grava em <cwd>/.claude', async (t) => {
  const ctx = await tmpCtx(t, 'project');
  const plan = ADAPTERS.claude.plan(ctx);
  assert.ok(plan.files.every((f) => f.path.startsWith(join(ctx.cwd, '.claude'))));
  assert.match(plan.notes.join('\n'), /project|projeto/i);
});

test('claude: mantém CLAUDE_SKILL_DIR e a injeção por ! intactos (a skill do Claude não muda)', async (t) => {
  const plan = ADAPTERS.claude.plan(await tmpCtx(t));
  assert.equal(skillOf(plan, '/skills/swarm/SKILL.md'), MOCK_SKILL);
  assert.equal(skillOf(plan, '/agents/swarm-worker.md'), MOCK_WORKER);
});

// ---------------------------------------------------------------- codex
test('codex: metadados (verificado só pela documentação, não está na máquina)', () => {
  const a = ADAPTERS.codex;
  assert.equal(a.verified, 'doc');
  assert.equal(a.defaultSelected, true);
  assert.ok(a.notes.some((n) => /não verificado/i.test(n)));
});

test('codex: skill em .agents/skills e agentes TOML em .codex/agents (user)', async (t) => {
  const ctx = await tmpCtx(t);
  const plan = ADAPTERS.codex.plan(ctx);
  assert.equal(findFile(plan, '/.agents/skills/swarm/SKILL.md').path, join(ctx.home, '.agents', 'skills', 'swarm', 'SKILL.md'));
  assert.ok(findFile(plan, '/.agents/skills/swarm/scripts/board.mjs'));
  assert.equal(findFile(plan, '/.codex/agents/swarm-worker.toml').path, join(ctx.home, '.codex', 'agents', 'swarm-worker.toml'));
  assert.ok(findFile(plan, '/.codex/agents/swarm-verifier.toml'));
});

test('codex: escopo project usa <cwd>/.agents/skills e <cwd>/.codex/agents', async (t) => {
  const ctx = await tmpCtx(t, 'project');
  const plan = ADAPTERS.codex.plan(ctx);
  assert.equal(findFile(plan, '/.agents/skills/swarm/SKILL.md').path, join(ctx.cwd, '.agents', 'skills', 'swarm', 'SKILL.md'));
  assert.equal(findFile(plan, '/.codex/agents/swarm-worker.toml').path, join(ctx.cwd, '.codex', 'agents', 'swarm-worker.toml'));
});

test('codex: SKILL.md só com name e description, sem argument-hint nem shell', async (t) => {
  const plan = ADAPTERS.codex.plan(await tmpCtx(t));
  const { data, body } = parseFrontmatter(skillOf(plan, '/skills/swarm/SKILL.md'));
  assert.deepEqual(Object.keys(data), ['name', 'description']);
  assert.equal(data.name, 'swarm');
  assert.match(data.description, /#seq/, 'a descrição sobrevive ao YAML mesmo com # e dois-pontos');
  assert.match(body, /^\s*# Adaptação para Codex/);
});

test('codex: agente TOML tem name, description e developer_instructions válidos', async (t) => {
  const plan = ADAPTERS.codex.plan(await tmpCtx(t));
  const toml = skillOf(plan, '/agents/swarm-worker.toml');
  assert.match(toml, /^name = "swarm-worker"$/m);
  assert.match(toml, /^description = ".*swarm.*"$/m);
  assert.match(toml, /^developer_instructions = """\n/m);
  assert.match(toml, /# Adaptação para Codex/);
  assert.match(toml, /# Você é um worker de um swarm/);
  assert.ok(toml.trimEnd().endsWith('"""'));
  assert.doesNotMatch(toml, /^model|^color|^tools/m, 'sem campos que o Codex não documenta');
});

test('codex: o verifier avisa que não existe bloqueio técnico de edição', async (t) => {
  const plan = ADAPTERS.codex.plan(await tmpCtx(t));
  const toml = skillOf(plan, '/agents/swarm-verifier.toml');
  assert.match(toml, /não há (bloqueio|equivalente)/i);
  assert.match(toml, /Não corrija|não corrige|Você não corrige/i);
});

test('codex: a skill aponta para o board.mjs instalado e para os arquivos de agente .toml reais', async (t) => {
  const ctx = await tmpCtx(t);
  const text = skillOf(ADAPTERS.codex.plan(ctx), '/skills/swarm/SKILL.md');
  assert.ok(text.includes(posix(join(ctx.home, '.agents', 'skills', 'swarm', 'scripts', 'board.mjs'))));
  assert.ok(text.includes(posix(join(ctx.home, '.codex', 'agents', 'swarm-worker.toml'))));
  assert.doesNotMatch(text, /~\/\.claude\/agents/);
});

test('codex: detecta ~/.codex e CODEX_HOME', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, 'h');
  assert.equal(ADAPTERS.codex.detect({ home, env: {} }), false);
  await writeTree(tmp.dir, { 'outro/config.toml': '' });
  assert.equal(ADAPTERS.codex.detect({ home, env: { CODEX_HOME: join(tmp.dir, 'outro') } }), true);
});

// ---------------------------------------------------------------- cursor
test('cursor: metadados e caminhos user/project', async (t) => {
  const a = ADAPTERS.cursor;
  assert.equal(a.verified, 'local');
  assert.equal(a.defaultSelected, true);
  const u = await tmpCtx(t);
  const pu = a.plan(u);
  assert.equal(findFile(pu, '/.cursor/skills/swarm/SKILL.md').path, join(u.home, '.cursor', 'skills', 'swarm', 'SKILL.md'));
  assert.equal(findFile(pu, '/.cursor/agents/swarm-worker.md').path, join(u.home, '.cursor', 'agents', 'swarm-worker.md'));
  const p = await tmpCtx(t, 'project');
  const pp = a.plan(p);
  assert.equal(findFile(pp, '/.cursor/skills/swarm/SKILL.md').path, join(p.cwd, '.cursor', 'skills', 'swarm', 'SKILL.md'));
  assert.equal(findFile(pp, '/.cursor/agents/swarm-verifier.md').path, join(p.cwd, '.cursor', 'agents', 'swarm-verifier.md'));
});

test('cursor: skill com disable-model-invocation e sem argument-hint/shell', async (t) => {
  const { data } = parseFrontmatter(skillOf(ADAPTERS.cursor.plan(await tmpCtx(t)), '/skills/swarm/SKILL.md'));
  assert.deepEqual(Object.keys(data), ['name', 'description', 'disable-model-invocation']);
  assert.equal(data['disable-model-invocation'], 'true');
});

test('cursor: worker e verifier rodam em background; o verifier NÃO tem readonly (poderia impedir o post no board)', async (t) => {
  const plan = ADAPTERS.cursor.plan(await tmpCtx(t));
  const w = parseFrontmatter(skillOf(plan, '/agents/swarm-worker.md'));
  assert.deepEqual(w.data, { name: 'swarm-worker', description: w.data.description, model: 'inherit', is_background: 'true' });
  const v = parseFrontmatter(skillOf(plan, '/agents/swarm-verifier.md'));
  assert.equal('readonly' in v.data, false);
  assert.deepEqual(Object.keys(v.data), ['name', 'description', 'model', 'is_background']);
  assert.equal(v.data.is_background, 'true');
  assert.equal(v.data.model, 'inherit');
  assert.match(v.body, /NÃO usa `readonly: true`/);
  assert.match(v.body, /só escreve no board/);
  assert.match(v.body, /não verificado/i);
  assert.match(ADAPTERS.cursor.notes.join(' '), /readonly: true não usado.*post no board.*não verificado/);
});

test('cursor: avisa que o Cursor também lê ~/.claude e que não há mensagem a subagente em execução', async (t) => {
  const plan = ADAPTERS.cursor.plan(await tmpCtx(t));
  const skill = skillOf(plan, '/skills/swarm/SKILL.md');
  assert.match(skill, /Resume agent|retomar|resume/i);
  assert.match(plan.notes.join('\n') + ADAPTERS.cursor.notes.join('\n'), /\.claude/);
});

// ---------------------------------------------------------------- opencode
test('opencode: metadados e caminhos user/project', async (t) => {
  const a = ADAPTERS.opencode;
  assert.equal(a.verified, 'local');
  assert.equal(a.defaultSelected, true);
  const u = await tmpCtx(t);
  const pu = a.plan(u);
  assert.equal(findFile(pu, '/skills/swarm/SKILL.md').path, join(u.home, '.config', 'opencode', 'skills', 'swarm', 'SKILL.md'));
  assert.equal(findFile(pu, '/agents/swarm-worker.md').path, join(u.home, '.config', 'opencode', 'agents', 'swarm-worker.md'));
  const p = await tmpCtx(t, 'project');
  const pp = a.plan(p);
  assert.equal(findFile(pp, '/.opencode/skills/swarm/SKILL.md').path, join(p.cwd, '.opencode', 'skills', 'swarm', 'SKILL.md'));
  assert.equal(findFile(pp, '/.opencode/agents/swarm-verifier.md').path, join(p.cwd, '.opencode', 'agents', 'swarm-verifier.md'));
});

test('opencode: agentes V2 (description, mode: subagent), verifier com permissions edit deny e sem campos legados', async (t) => {
  const plan = ADAPTERS.opencode.plan(await tmpCtx(t));
  const worker = skillOf(plan, '/agents/swarm-worker.md');
  const w = parseFrontmatter(worker.replace(/permissions:[\s\S]*?\n---/, '---'));
  assert.equal(w.data.mode, 'subagent');
  assert.doesNotMatch(worker, /^permissions:/m);
  const verifier = skillOf(plan, '/agents/swarm-verifier.md');
  assert.match(verifier, /^mode: subagent$/m);
  assert.match(verifier, /^permissions:\n  - action: edit\n    resource: "\*"\n    effect: deny\n---/m);
  for (const legado of ['tools:', 'permission:', 'temperature:']) assert.ok(!verifier.includes(`\n${legado}`), legado);
});

test('opencode: o verifier avisa que o shell ainda grava arquivos (deny de edit não cobre)', async (t) => {
  const verifier = skillOf(ADAPTERS.opencode.plan(await tmpCtx(t)), '/agents/swarm-verifier.md');
  assert.match(verifier, /shell/i);
  assert.match(verifier, /não cobre|não bloqueia/i);
});

test('opencode: a skill usa a tool subagent com sessionID para acordar', async (t) => {
  const text = skillOf(ADAPTERS.opencode.plan(await tmpCtx(t)), '/skills/swarm/SKILL.md');
  assert.match(text, /sessionID/);
  assert.match(text, /# Adaptação para opencode/);
  const { data } = parseFrontmatter(text);
  assert.deepEqual(Object.keys(data), ['name', 'description']);
});

// ---------------------------------------------------------------- gemini
test('gemini: metadados e caminhos user/project', async (t) => {
  const a = ADAPTERS.gemini;
  assert.equal(a.verified, 'local');
  assert.equal(a.defaultSelected, true);
  const u = await tmpCtx(t);
  const pu = a.plan(u);
  assert.equal(findFile(pu, '/.gemini/skills/swarm/SKILL.md').path, join(u.home, '.gemini', 'skills', 'swarm', 'SKILL.md'));
  assert.equal(findFile(pu, '/.gemini/agents/swarm-worker.md').path, join(u.home, '.gemini', 'agents', 'swarm-worker.md'));
  const p = await tmpCtx(t, 'project');
  const pp = a.plan(p);
  assert.equal(findFile(pp, '/.gemini/skills/swarm/SKILL.md').path, join(p.cwd, '.gemini', 'skills', 'swarm', 'SKILL.md'));
  assert.equal(findFile(pp, '/.gemini/agents/swarm-verifier.md').path, join(p.cwd, '.gemini', 'agents', 'swarm-verifier.md'));
});

test('gemini: verifier com tools explícito sem escrita; worker herda tudo (sem tools); ambos com model inherit', async (t) => {
  const plan = ADAPTERS.gemini.plan(await tmpCtx(t));
  const w = parseFrontmatter(skillOf(plan, '/agents/swarm-worker.md'));
  assert.deepEqual(Object.keys(w.data), ['name', 'description', 'model']);
  assert.equal(w.data.model, 'inherit');
  const raw = skillOf(plan, '/agents/swarm-verifier.md');
  assert.match(raw, /^tools: \[read_file, read_many_files, grep_search, glob, list_directory, run_shell_command\]$/m);
  assert.doesNotMatch(raw.split('\n---\n')[0], /write_file|replace/);
  const v = parseFrontmatter(raw);
  assert.equal(v.data.name, 'swarm-verifier');
});

test('gemini: avisa que subagentes não chamam subagentes e que não há como acordar um subagente', async (t) => {
  const text = skillOf(ADAPTERS.gemini.plan(await tmpCtx(t)), '/skills/swarm/SKILL.md');
  assert.match(text, /não (podem|pode) chamar outros subagentes|cannot call other subagents/i);
  assert.match(text, /invoke_agent/);
  assert.match(text, /activate_skill/);
});

test('gemini: detecta pelo ~/.gemini/settings.json e não pelo ~/.gemini do Antigravity', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, { 'h/.gemini/antigravity/x': '1' });
  assert.equal(ADAPTERS.gemini.detect({ home: join(tmp.dir, 'h'), env: {} }), false);
  assert.equal(ADAPTERS.antigravity.detect({ home: join(tmp.dir, 'h'), env: {} }), true);
});

// ---------------------------------------------------------------- antigravity
test('antigravity: desmarcado por padrão, instala como swarm-board e avisa do /swarm nativo', () => {
  const a = ADAPTERS.antigravity;
  assert.equal(a.defaultSelected, false);
  assert.equal(a.verified, 'local');
  assert.match(a.notes.join('\n'), /\/swarm nativo/);
  assert.match(a.notes.join('\n'), /swarm-board/);
});

test('antigravity: caminhos user (~/.gemini/config) e project (.agents)', async (t) => {
  const u = await tmpCtx(t);
  const pu = ADAPTERS.antigravity.plan(u);
  assert.equal(findFile(pu, '/skills/swarm-board/SKILL.md').path, join(u.home, '.gemini', 'config', 'skills', 'swarm-board', 'SKILL.md'));
  assert.equal(findFile(pu, '/agents/swarm-worker.md').path, join(u.home, '.gemini', 'config', 'agents', 'swarm-worker.md'));
  assert.ok(!pu.files.some((f) => posix(f.path).includes('/skills/swarm/')), 'nunca usa o nome swarm');
  const p = await tmpCtx(t, 'project');
  const pp = ADAPTERS.antigravity.plan(p);
  assert.equal(findFile(pp, '/.agents/skills/swarm-board/SKILL.md').path, join(p.cwd, '.agents', 'skills', 'swarm-board', 'SKILL.md'));
  assert.equal(findFile(pp, '/.agents/agents/swarm-verifier.md').path, join(p.cwd, '.agents', 'agents', 'swarm-verifier.md'));
});

test('antigravity: frontmatter da skill com name swarm-board e descrição apontando /swarm-board', async (t) => {
  const { data } = parseFrontmatter(skillOf(ADAPTERS.antigravity.plan(await tmpCtx(t)), '/skills/swarm-board/SKILL.md'));
  assert.deepEqual(Object.keys(data), ['name', 'description']);
  assert.equal(data.name, 'swarm-board');
  assert.match(data.description, /pedir \/swarm-board,/);
  assert.match(data.description, /Inspirado no \/swarm do Google Antigravity/, 'a menção histórica não é renomeada');
});

test('antigravity: agentes com tools explícito, subagent true, mainAgent false, sem model nem color', async (t) => {
  const plan = ADAPTERS.antigravity.plan(await tmpCtx(t));
  const w = skillOf(plan, '/agents/swarm-worker.md');
  assert.match(w, /^tools: \[read_file, edit_file, write_file, run_command, manage_task, search_web\]$/m);
  assert.match(w, /^subagent: true$/m);
  assert.match(w, /^mainAgent: false$/m);
  assert.doesNotMatch(w.split('\n---\n')[0], /^model:|^color:/m);
  const v = skillOf(plan, '/agents/swarm-verifier.md');
  assert.match(v, /^tools: \[read_file, run_command, manage_task, search_web\]$/m);
  assert.doesNotMatch(v.split('\n---\n')[0], /edit_file|write_file/);
});

test('antigravity: a skill diz que o comando é /swarm-board e usa send_message', async (t) => {
  const plan = ADAPTERS.antigravity.plan(await tmpCtx(t));
  const text = skillOf(plan, '/skills/swarm-board/SKILL.md');
  assert.match(text, /\/swarm-board/);
  assert.match(text, /send_message/);
  assert.match(plan.notes.join('\n'), /\/skills reload/);
  assert.match(plan.notes.join('\n'), /nativo/);
});

// ---------------------------------------------------------------- comum aos não-Claude
for (const id of ['codex', 'cursor', 'opencode', 'gemini', 'antigravity']) {
  test(`${id}: a skill embute o caminho absoluto do board.mjs instalado, o estado fora de ~/.claude e o passo explícito do status`, async (t) => {
    const ctx = await tmpCtx(t);
    const plan = ADAPTERS[id].plan(ctx);
    const skillMd = plan.files.find((f) => posix(f.path).endsWith('/SKILL.md'));
    const board = posix(join(skillMd.path, '..', 'scripts', 'board.mjs'));
    const text = textOfFile(skillMd);
    assert.ok(findFile(plan, '/scripts/board.mjs').path === join(skillMd.path, '..', 'scripts', 'board.mjs'));
    assert.ok(text.includes(`BOARD = node "${board}" --dir "${posix(join(ctx.home, '.swarm-agents', 'swarm'))}/<ID-DO-SWARM>"`));
    assert.match(text, /swarm-AAAAMMDD-HHMM/);
    assert.match(text, /BOARD status/);
    assert.match(text, /--backend subagents/);
    assert.doesNotMatch(text, /\$ARGUMENTS/);
    assert.match(text, /## Equivalências/);
    assert.match(text, /não verificado/i);
  });

  test(`${id}: arquivos de runtime (board.mjs, lib, models.json, references) vão byte a byte, sem tocar no conteúdo`, async (t) => {
    const ctx = await tmpCtx(t);
    const plan = ADAPTERS[id].plan(ctx);
    for (const rel of ['scripts/board.mjs', 'scripts/lib/cli.mjs', 'models.json', 'package.json', 'references/backends.md']) {
      const f = findFile(plan, `/${rel}`);
      assert.ok(Buffer.isBuffer(f.content));
      assert.ok(f.content.equals(ctx.payload.get(`skills/swarm/${rel}`)), rel);
    }
  });

  test(`${id}: os agentes mantêm o corpo original do payload depois da adaptação`, async (t) => {
    const plan = ADAPTERS[id].plan(await tmpCtx(t));
    const worker = skillOf(plan, id === 'codex' ? '/agents/swarm-worker.toml' : '/agents/swarm-worker.md');
    assert.match(worker, /# Adaptação para /);
    assert.match(worker, /Corpo do worker com `read --for <você>`\./);
    assert.ok(worker.indexOf('# Adaptação para ') < worker.indexOf('# Você é um worker de um swarm'));
  });

  test(`${id}: payload com SKILL.md de outra versão falha com mensagem amigável`, async (t) => {
    const bad = mockPayload({ 'skills/swarm/SKILL.md': MOCK_SKILL.replace(/^BOARD = .*$/m, 'BOARD = outra coisa') });
    const ctx = await tmpCtx(t, 'user', bad);
    assert.throws(() => ADAPTERS[id].plan(ctx), (e) => {
      assert.equal(e.code, 'PAYLOAD_INCOMPATIVEL');
      assert.match(e.message, /reinstale/i);
      return true;
    });
  });

  test(`${id}: SKILL.md com resquício do Claude que o adapter não conhece é recusado`, async (t) => {
    const bad = mockPayload({ 'skills/swarm/SKILL.md': `${MOCK_SKILL}\nmais um \${CLAUDE_SKILL_DIR}/x\n` });
    assert.throws(() => ADAPTERS[id].plan(ctxFor(join('/', 'x'), 'user', bad)), { code: 'PAYLOAD_INCOMPATIVEL' });
  });
}

test('payload com CRLF no SKILL.md também é adaptado (fim de linha normalizado)', async (t) => {
  const crlf = mockPayload({ 'skills/swarm/SKILL.md': MOCK_SKILL.replaceAll('\n', '\r\n') });
  const plan = ADAPTERS.cursor.plan(await tmpCtx(t, 'user', crlf));
  assert.doesNotMatch(skillOf(plan, '/skills/swarm/SKILL.md'), /\r/);
});

test('o verifier de toda ferramenta não-Claude manda valer o item "Somente leitura" no lugar do texto do Claude', async (t) => {
  for (const id of ['codex', 'cursor', 'opencode', 'gemini', 'antigravity']) {
    const plan = ADAPTERS[id].plan(await tmpCtx(t));
    const verifier = skillOf(plan, id === 'codex' ? '/agents/swarm-verifier.toml' : '/agents/swarm-verifier.md');
    assert.match(verifier, /vale o item "Somente leitura"/, id);
    const worker = skillOf(plan, id === 'codex' ? '/agents/swarm-worker.toml' : '/agents/swarm-worker.md');
    assert.doesNotMatch(worker, /vale o item "Somente leitura"/, id);
  }
});

test('todo plano não-Claude diz onde ficam os boards (fora das pastas da ferramenta)', async (t) => {
  for (const id of ['codex', 'cursor', 'opencode', 'gemini', 'antigravity']) {
    const ctx = await tmpCtx(t);
    const notes = ADAPTERS[id].plan(ctx).notes.join('\n');
    assert.ok(notes.includes(`${posix(join(ctx.home, '.swarm-agents', 'swarm'))}/<ID-DO-SWARM>`), id);
  }
});

test('a proteção do verifier nunca impede o post no board: shell liberado em todas as ferramentas', async (t) => {
  const gem = skillOf(ADAPTERS.gemini.plan(await tmpCtx(t)), '/agents/swarm-verifier.md');
  assert.match(gem, /^tools: \[.*run_shell_command.*\]$/m);
  const agy = skillOf(ADAPTERS.antigravity.plan(await tmpCtx(t)), '/agents/swarm-verifier.md');
  assert.match(agy, /^tools: \[.*run_command.*\]$/m);
  const cur = skillOf(ADAPTERS.cursor.plan(await tmpCtx(t)), '/agents/swarm-verifier.md');
  assert.doesNotMatch(cur.split(/\n---\n/)[0], /readonly/);
  const oc = skillOf(ADAPTERS.opencode.plan(await tmpCtx(t)), '/agents/swarm-verifier.md');
  assert.doesNotMatch(oc.split(/\n---\n/)[0], /action: (shell|\*)/);
  assert.match(oc, /inferência.*não verificado/);
});
