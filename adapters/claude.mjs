// Adapter do Claude Code: IDENTIDADE. O resultado instalado é o mesmo de hoje, byte a byte: cada arquivo do payload vai
// para o mesmo caminho relativo dentro de <claude>/ (skills/swarm/** e agents/*) sem tocar no conteúdo.
import { join } from 'node:path';
import { assertAbsolute, assertScope, dirExists } from './lib/paths.mjs';
import { assertPayload } from './lib/payload.mjs';
import { resolveReads } from './lib/reads.mjs';

// Pastas que o Claude Code carrega (comportamento atual; as docs oficiais dele não foram relidas): skills e agentes de usuário e de projeto.
const READS = { user: [['.claude', 'skills'], ['.claude', 'agents']], project: [['.claude', 'skills'], ['.claude', 'agents']] };

const baseDir = ({ scope, home, cwd }) => join(scope === 'user' ? home : cwd, '.claude');

export const claude = Object.freeze({
  id: 'claude',
  name: 'Claude Code',
  defaultSelected: true,
  verified: 'native-claude',
  notes: Object.freeze([
    'Instalação idêntica à atual: os arquivos do payload são copiados sem alteração para ~/.claude/skills/swarm e ~/.claude/agents.',
    'Não verificado: a variável CLAUDE_CONFIG_DIR (o instalador usa ~/.claude, ou <projeto>/.claude no escopo project).',
  ]),

  detect(ctx) {
    const { home } = ctx ?? {};
    if (typeof home !== 'string') return false;
    try {
      assertAbsolute('home', home);
    } catch {
      return false;
    }
    return dirExists(join(home, '.claude'));
  },

  plan(input) {
    const { scope, home, cwd, payload } = input ?? {};
    assertScope(scope);
    assertAbsolute('home', home);
    if (scope === 'project') assertAbsolute('cwd', cwd);
    assertPayload(payload);
    const base = baseDir({ scope, home, cwd });
    const files = [...payload.keys()].sort().map((rel) => ({
      path: join(base, ...rel.split('/')),
      content: Buffer.from(payload.get(rel)),
    }));
    const where = scope === 'user' ? 'no escopo user (~/.claude)' : 'no escopo project (<projeto>/.claude)';
    return { reads: resolveReads(READS, home, cwd), files, notes: [`Claude Code: ${payload.size} arquivos copiados sem alteração ${where}. Abra uma sessão nova para o /swarm e os agentes carregarem.`] };
  },
});
