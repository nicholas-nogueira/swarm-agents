// Adapter do Cursor. Fonte: harness-docs.md seção 3 (documentação oficial + pasta local ~/.cursor, que existe nesta máquina).
// Skills em .cursor/skills, subagentes em .cursor/agents (Markdown com frontmatter name/description/model/is_background).
import { join } from 'node:path';
import { createAdapter, markdownAgent } from './lib/factory.mjs';
import { COMMON_ROWS } from './lib/docs-common.mjs';

const docs = {
  invoke:
    'toda skill vira o comando `/swarm` no chat do Cursor. Ela foi instalada com `disable-model-invocation: true`: o Cursor só a usa quando você digita `/swarm`.',
  spawn:
    'use o Task do Cursor (subagente) com o agente `swarm-worker` ou `swarm-verifier` e o prompt impresso por `member add`. Os dois agentes já têm `is_background: true` (rodam sem bloquear o pai) e várias chamadas Task na mesma mensagem rodam em paralelo. Também dá para chamar o agente por `/swarm-worker` ou por menção. A saída dos subagentes em segundo plano fica em `~/.cursor/subagents/`.',
  wake: 'não há mensagem para um subagente em execução (não encontrado na documentação). Cada execução devolve um agent ID: para acordar um worker que terminou a vez, peça "Resume agent <id>" e guarde o ID com `BOARD member update --name <nome> --agent-id <id>`. Se o resume não funcionar, crie um subagente novo com o mesmo nome e mande rodar `BOARD read --for <nome>`: o cursor de leitura fica no board, por nome.',
  stop: 'não encontrado na documentação (não há `TaskStop`). Use `BOARD member kill --name <nome>` e deixe o subagente terminar.',
  helpers:
    'desde o Cursor 2.5 um subagente pode lançar subagentes filhos, mas só 1 nível: o coordenador cria os workers, um worker pode criar helpers e um helper não cria outros. `fork` não existe: crie o worker normal e aponte os `#seq` no brief.',
  model: 'Os agentes usam `model: inherit` (o modelo do chat). O pai também pode escolher o modelo de cada subagente, segundo a documentação.',
  shell: 'o Cursor roda comandos no terminal; qual shell no Windows: não verificado (os hooks dele usam PowerShell). Os exemplos com heredoc (`<<\'EOF\'`) são de shell POSIX; em PowerShell envie o texto por pipe (`@\'...\'@ | node ...`).',
  guard:
    'o agente `swarm-verifier` NÃO usa `readonly: true` no Cursor, porque a documentação diz que ele bloqueia "no file edits, no state-changing shell commands" e isso pode impedir o `node board.mjs post` (que grava no board): não verificado. Logo não há bloqueio técnico: você não edita arquivos do projeto e só escreve no board; a regra vale por instrução e você a cumpre por conta própria.',
  agentWake:
    'o Cursor retoma um subagente por agent ID ("Resume agent <id>") e não aceita mensagem enquanto ele roda: ao retomar, rode `read --for <você>` antes de agir.',
  agentHelpers: 'só 1 nível de subagentes filhos no Cursor: crie helpers só se for indispensável, e nunca peça a um helper que crie outro.',
  mapping: [
    ['`Agent{subagent_type: "swarm-worker", prompt, run_in_background: true}`', 'Task com o agente `swarm-worker` (`is_background: true` no arquivo do agente)'],
    ['`SendMessage{to: <agent_id>, message}`', '"Resume agent <id>" (retomar por agent ID); mensagem a subagente em execução não existe'],
    ['`TaskStop`', 'não encontrado: `BOARD member kill`'],
    ['`disallowedTools: Edit, Write, NotebookEdit` do verifier', 'sem equivalente usado: `readonly: true` existe, mas pode impedir o `post` do board (não verificado); só instrução no texto do agente'],
    ...COMMON_ROWS,
  ],
  absent: [
    '`argument-hint` e `shell` no frontmatter da skill (existem `disable-model-invocation`, `paths`, `icon`, `color`, `metadata`)',
    'variável de diretório da skill e injeção de saída de comando dentro de skills',
    'mensagem direta a um subagente em execução',
    'parar um subagente por ferramenta (`TaskStop`)',
  ],
  unverified: [
    'se `readonly: true` bloquearia o `post` do board (comando que grava arquivo): por isso o verifier não o usa',
    'o shell que executa os comandos no Windows',
    'qual skill vence quando `~/.claude/skills` e `~/.cursor/skills` têm uma skill `swarm` (o Cursor lê as duas pastas; para agentes a documentação diz que `.cursor/` vence)',
  ],
};

const profile = {
  id: 'cursor',
  name: 'Cursor',
  defaultSelected: true,
  verified: 'local',
  notes: [
    '~/.cursor existe na máquina onde o instalador foi escrito e a estrutura de skills foi lida; o formato dos agentes vem da documentação oficial. O Cursor não foi executado.',
    'Skill em ~/.cursor/skills/swarm e agentes em ~/.cursor/agents (project: <projeto>/.cursor/...).',
    'O Cursor também carrega ~/.claude/skills e ~/.claude/agents: com o Claude Code instalado ao mesmo tempo haverá duas skills `swarm`; para agentes a documentação diz que .cursor/ vence, para skills não verificado.',
    'readonly: true não usado no verifier porque pode impedir o post no board (não verificado): a proteção contra edição é só instrução no texto do agente; shell no Windows não verificado.',
    'Pasta compartilhada: ~/.agents/skills (e <projeto>/.agents/skills) também é lida por Codex, opencode e Gemini CLI. Instalar o Cursor junto com qualquer um deles pode mostrar duas skills `swarm` (cada uma com o texto adaptado a outra ferramenta); qual vence: não verificado. O plano declara as pastas lidas no campo `reads`.',
    'O instalador não edita ~/.cursor/mcp.json (que pode guardar segredos), hooks nem regras.',
  ],
  reads: {
    user: [['.cursor', 'skills'], ['.agents', 'skills'], ['.claude', 'skills'], ['.codex', 'skills'], ['.cursor', 'agents'], ['.claude', 'agents'], ['.codex', 'agents']],
    project: [['.cursor', 'skills'], ['.agents', 'skills'], ['.claude', 'skills'], ['.codex', 'skills'], ['.cursor', 'agents'], ['.claude', 'agents'], ['.codex', 'agents']],
  },
  skillName: 'swarm',
  agentExt: '.md',
  docs,

  markers: ({ home }) => [{ dir: join(home, '.cursor') }],
  layout: ({ scope, home, cwd }) => {
    const base = join(scope === 'user' ? home : cwd, '.cursor');
    return { skills: join(base, 'skills'), agents: join(base, 'agents') };
  },
  skillFrontmatter: ({ name, description }) => ({ name, description, 'disable-model-invocation': true }),
  agentFile: ({ name, description, body }) =>
    markdownAgent({ name, description, model: 'inherit', is_background: true }, body),
};

export const cursor = createAdapter(profile);
