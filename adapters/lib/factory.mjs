// Fábrica dos adapters das ferramentas que NÃO são o Claude Code (Strategy: cada ferramenta entrega um perfil
// declarativo e esta fábrica faz o trabalho comum: validar entradas, adaptar o SKILL.md, gerar os agentes e planejar
// os arquivos). O instalador só grava o que o plano devolve; este módulo nunca escreve no disco.
import { isAbsolute, join } from 'node:path';
import { AdapterError } from './errors.mjs';
import { agentAdaptation, skillAdaptation } from './adaptation.mjs';
import { buildFrontmatter, parseFrontmatter } from './frontmatter.mjs';
import { resolveReads } from './reads.mjs';
import { assertAbsolute, assertScope, dirExists, fileExists } from './paths.mjs';
import { WORKER_FILE, VERIFIER_FILE, assertPayload, skillEntries, textOf } from './payload.mjs';
import { assertNone, normalizeEol, replaceLine, replaceOnce, toPosix } from './text.mjs';

/** Pasta de estado dos boards das ferramentas que não são o Claude (o Claude continua em ~/.claude/swarm). */
export const stateRootOf = (home) => toPosix(join(home, '.swarm-agents', 'swarm'));

const AGENT_SOURCES = { worker: WORKER_FILE, verifier: VERIFIER_FILE };

/** Arquivo Markdown de agente: frontmatter + corpo. */
export const markdownAgent = (frontmatter, body) => `${buildFrontmatter(frontmatter)}\n${body}`;

const incompat = (msg) => new AdapterError(msg, 'PAYLOAD_INCOMPATIVEL');

function renderSkill(profile, source, ctx) {
  const { data, body } = parseFrontmatter(source);
  if (!data.description) throw incompat('O SKILL.md do pacote não tem descrição. Reinstale o swarm-agents.');
  let description = data.description;
  for (const [from, to] of profile.descriptionTweaks ?? []) description = replaceOnce(description, from, to, 'descrição da skill');

  let text = normalizeEol(body);
  text = replaceOnce(
    text,
    'Entrada do usuário: `$ARGUMENTS`',
    'Entrada do usuário: o texto que acompanha a chamada da skill (veja "Adaptação" acima).',
    'entrada do usuário',
  );
  text = replaceLine(
    text,
    /^BOARD = node "\$\{CLAUDE_SKILL_DIR\}[^\n]*$/m,
    `BOARD = node "${ctx.boardPath}" --dir "${ctx.stateRoot}/<ID-DO-SWARM>"`,
    'definição do BOARD',
  );
  text = replaceLine(
    text,
    /^!`node "\$\{CLAUDE_SKILL_DIR\}[^\n]*`$/m,
    'Rode `BOARD status` como primeiro passo (veja "Adaptação" acima). Se der erro, ainda não há swarm com esse ID.',
    'injeção do estado',
  );
  text = replaceLine(
    text,
    /^Motor: !`[^\n]*`$/m,
    'Motor: `subagents`. O motor `teams` não existe aqui: crie o swarm com `BOARD init --title "<título>" --backend subagents`.',
    'injeção do motor',
  );
  text = text.replace(/~\/\.claude\/agents\/swarm-(worker|verifier)\.md/g, (_m, kind) => toPosix(ctx.agentPaths[kind]));
  assertNone(text, [/CLAUDE_SKILL_DIR/, /CLAUDE_SESSION_ID/, /^!`/m], 'SKILL.md');

  const front = buildFrontmatter(profile.skillFrontmatter({ name: profile.skillName, description }));
  return `${front}\n${skillAdaptation(profile, ctx)}${text.replace(/^\n+/, '')}`;
}

function renderAgent(profile, kind, source) {
  const { data, body } = parseFrontmatter(source);
  if (!data.description) throw incompat(`O agente swarm-${kind} do pacote não tem descrição. Reinstale o swarm-agents.`);
  const full = `${agentAdaptation(profile, kind)}${normalizeEol(body).replace(/^\n+/, '')}`;
  return profile.agentFile({ kind, name: `swarm-${kind}`, description: data.description, body: full });
}

/**
 * Monta o adapter a partir do perfil da ferramenta.
 * @param {object} profile ver adapters/<ferramenta>.mjs
 */
export function createAdapter(profile) {
  return Object.freeze({
    id: profile.id,
    name: profile.name,
    defaultSelected: profile.defaultSelected,
    verified: profile.verified,
    notes: Object.freeze([...profile.notes]),

    detect(ctx) {
      const { home, env = {} } = ctx ?? {};
      if (typeof home !== 'string' || home.includes('\u0000') || !isAbsolute(home)) return false;
      return profile.markers({ home, env }).some((m) => (m.dir ? dirExists(m.dir) : fileExists(m.file)));
    },

    plan(input) {
      const { scope, home, cwd, payload } = input ?? {};
      assertScope(scope);
      assertAbsolute('home', home);
      if (scope === 'project') assertAbsolute('cwd', cwd);
      assertPayload(payload);

      const { skills, agents } = profile.layout({ scope, home, cwd });
      const skillDir = join(skills, profile.skillName);
      const agentPaths = {};
      for (const kind of Object.keys(AGENT_SOURCES)) agentPaths[kind] = join(agents, `swarm-${kind}${profile.agentExt}`);
      const ctx = { boardPath: toPosix(join(skillDir, 'scripts', 'board.mjs')), stateRoot: stateRootOf(home), agentPaths };

      const files = skillEntries(payload).map(({ rel, content }) => ({
        path: join(skillDir, ...rel.split('/')),
        content: rel === 'SKILL.md' ? renderSkill(profile, content.toString('utf8'), ctx) : content,
      }));
      for (const [kind, src] of Object.entries(AGENT_SOURCES)) {
        files.push({ path: agentPaths[kind], content: renderAgent(profile, kind, textOf(payload, src)) });
      }

      const notes = [
        `Escopo ${scope}: skill "${profile.skillName}" em ${skillDir}; agentes em ${agents}.`,
        `Os boards criados por esta skill ficam em ${ctx.stateRoot}/<ID-DO-SWARM> (fora das pastas da ferramenta).`,
        ...(profile.planNotes?.({ scope }) ?? []),
      ];
      return { files, notes, reads: resolveReads(profile.reads, home, cwd) };
    },
  });
}

