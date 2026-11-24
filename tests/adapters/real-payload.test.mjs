// Integração: os adapters contra o payload REAL do repositório (payload/), sem mocks.
// Garante a Regra 1 (Claude idêntico à linha de base, byte a byte) e que o SKILL.md real é adaptável por todas as ferramentas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ADAPTERS, listAdapters } from '../../adapters/index.mjs';
import { parseFrontmatter } from '../../adapters/lib/frontmatter.mjs';
import { ctxFor, makeTmp, realPayload, temPayloadReal, textOfFile, findFile, posix, RAIZ } from './helpers.mjs';

const skip = temPayloadReal() ? false : 'payload/ ainda não existe neste checkout';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

test('claude + payload real: todo arquivo instalado tem o mesmo sha256 da linha de base (Regra 1)', { skip }, async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const baselineFile = join(RAIZ, 'tests', 'golden', 'baseline-claude.sha256');
  const baseline = new Map(
    (await readFile(baselineFile, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l);
        return [m[2], m[1]];
      }),
  );
  const ctx = ctxFor(tmp.dir, 'user', await realPayload());
  const plan = ADAPTERS.claude.plan(ctx);
  const base = join(ctx.home, '.claude');
  let conferidos = 0;
  for (const f of plan.files) {
    const rel = posix(relative(base, f.path));
    if (baseline.has(rel)) {
      assert.equal(sha(f.content), baseline.get(rel), `diverge da linha de base: ${rel}`);
      conferidos += 1;
    }
  }
  const instaladosDaSkill = [...baseline.keys()].filter((k) => !k.startsWith('skills/swarm/tests/'));
  assert.equal(conferidos, instaladosDaSkill.length, 'todo arquivo de runtime da linha de base precisa estar no plano');
});

for (const a of listAdapters().filter((x) => x.id !== 'claude')) {
  test(`${a.id} + payload real: SKILL.md e agentes gerados, sem resquício do Claude e com o board certo`, { skip }, async (t) => {
    const tmp = await makeTmp();
    t.after(tmp.cleanup);
    const ctx = ctxFor(tmp.dir, 'user', await realPayload());
    const plan = a.plan(ctx);

    const skillFile = plan.files.find((f) => posix(f.path).endsWith('/SKILL.md'));
    const skill = textOfFile(skillFile);
    const { data, body } = parseFrontmatter(skill);
    assert.equal(data.name, a.id === 'antigravity' ? 'swarm-board' : 'swarm');
    assert.ok(data.description.length > 40);
    assert.match(body, /^\s*# Adaptação para /);
    assert.match(body, /# Você é o coordenador do swarm/);

    const board = posix(join(skillFile.path, '..', 'scripts', 'board.mjs'));
    assert.ok(skill.includes(`BOARD = node "${board}" --dir "`), 'definição do BOARD com caminho absoluto instalado');
    for (const re of [/CLAUDE_SKILL_DIR/, /CLAUDE_SESSION_ID/, /CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/, /^!`/m, /\$ARGUMENTS/, /~\/\.claude\/agents/]) {
      assert.doesNotMatch(skill, re, `${a.id}: sobrou ${re}`);
    }
    // as 3 construções específicas trocadas ficam explícitas para o coordenador
    assert.match(skill, /Rode `BOARD status` como primeiro passo/);
    assert.match(skill, /Motor: `subagents`/);

    for (const file of plan.files.filter((f) => /\/agents\//.test(posix(f.path)))) {
      const txt = textOfFile(file);
      assert.match(txt, /# Adaptação para /);
      assert.doesNotMatch(txt, /CLAUDE_SKILL_DIR|CLAUDE_SESSION_ID/);
    }
  });

  test(`${a.id} + payload real: instalar duas vezes dá o mesmo plano (idempotência por bytes)`, { skip }, async (t) => {
    const tmp = await makeTmp();
    t.after(tmp.cleanup);
    const ctx = ctxFor(tmp.dir, 'user', await realPayload());
    const a1 = a.plan(ctx);
    const a2 = a.plan(ctx);
    assert.deepEqual(
      a1.files.map((f) => [f.path, sha(Buffer.from(f.content))]),
      a2.files.map((f) => [f.path, sha(Buffer.from(f.content))]),
    );
  });
}

test('payload real: a skill adaptada ainda tem as 4 seções do protocolo do coordenador', { skip }, async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  const plan = ADAPTERS.opencode.plan(ctxFor(tmp.dir, 'user', await realPayload()));
  const skill = textOfFile(findFile(plan, '/skills/swarm/SKILL.md'));
  for (const titulo of ['## Roteamento da entrada', '## Não faça o trabalho', '## Iniciar', '## Manter andando (o loop)', '## Integrar e encerrar']) {
    assert.ok(skill.includes(titulo), titulo);
  }
});
