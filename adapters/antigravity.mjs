// Adapter do Antigravity (Google). Fontes: harness-docs.md seção 2 (instalação local em ~/.gemini/antigravity, com as skills
// embutidas lidas) e a skill local migrate-agent-settings (mapeamento oficial Claude -> Antigravity: tools, subagent, mainAgent).
// O Antigravity já tem um /swarm NATIVO: por isso este adapter fica desmarcado por padrão e instala como `swarm-board`.
import { join } from 'node:path';
import { createAdapter, markdownAgent } from './lib/factory.mjs';
import { COMMON_ROWS } from './lib/docs-common.mjs';

/** Mapeamento oficial local: Claude sem `tools` (todas) vira esta lista; o verifier perde Edit/Write (edit_file, write_file). */
export const ANTIGRAVITY_WORKER_TOOLS = Object.freeze(['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web']);
export const ANTIGRAVITY_VERIFIER_TOOLS = Object.freeze(['read_file', 'run_command', 'manage_task', 'search_web']);

const docs = {
  invoke:
    'esta skill é instalada como `swarm-board`: o comando é `/swarm-board` (toda skill vira slash command; rode `/skills reload` depois de instalar). O `/swarm` sem sufixo é o swarm NATIVO do Antigravity (ferramentas `swarm`, `post_message`, `read_board`, `swarm_wait`), outra coisa. Onde o texto abaixo diz `/swarm`, leia `/swarm-board`.',
  spawn:
    'use a ferramenta `invoke_subagent` com o agente `swarm-worker` (ou `swarm-verifier`) e o prompt impresso por `member add`. Como escolher um agente customizado pelo nome nessa ferramenta: não verificado (o material lido cita `TypeName` embutidos, `self` e `research`). Se não der, use `self` e comece o prompt com "Antes de tudo, leia e siga" seguido do caminho absoluto do arquivo do agente instalado.',
  wake: 'a ferramenta `send_message` está sempre incluída em `tools` (documentação de plugins) e a CLI aceita mensagem direta `@worker`: mande ao worker "Novas menções no board: rode `BOARD read --for <nome>` e continue". Se `send_message` não estiver disponível para os agentes instalados (a lista `tools` é explícita): não verificado.',
  stop: 'o `swarm{action:"kill"}` pertence ao swarm nativo e não conhece os membros deste board. Use `BOARD member kill --name <nome>`. Encerrar a execução do subagente por ferramenta: não verificado.',
  helpers:
    'a documentação do Antigravity permite subagentes aninhados (até 10 níveis): um worker pode criar helpers. `fork` não existe: crie o worker normal e aponte os `#seq` no brief.',
  model: 'Os agentes não declaram `model` (o mapeamento oficial de Claude para Antigravity descarta `model` e `color`).',
  shell:
    'a ferramenta de shell é `run_command`; o shell que ela usa no Windows: não verificado (hooks usam `sh -c` no Unix e `cmd /c` no Windows). Os exemplos com heredoc (`<<\'EOF\'`) são de shell POSIX; em PowerShell envie o texto por pipe (`@\'...\'@ | node ...`).',
  guard: `o agente \`swarm-verifier\` foi instalado com \`tools: [${ANTIGRAVITY_VERIFIER_TOOLS.join(', ')}]\`, sem \`edit_file\` nem \`write_file\`, e com \`run_command\` incluído de propósito para o \`post\` do board nunca ser impedido. \`run_command\` ainda pode gravar arquivos: você não edita nem pelo shell (sed, redirecionamento, scripts), só a regra garante isso.`,
  agentWake: 'a CLI do Antigravity manda mensagem direta ao agente (`@nome`) e `send_message` fica sempre incluída: ao ser acordado, rode `read --for <você>` antes de agir.',
  agentHelpers: 'o Antigravity aceita subagentes aninhados (até 10 níveis): crie helpers só se a sua peça se dividir de verdade.',
  mapping: [
    ['`Agent{subagent_type: "swarm-worker", prompt, run_in_background: true}`', '`invoke_subagent` com o agente `swarm-worker` (seleção pelo nome: não verificado)'],
    ['`SendMessage{to: <agent_id>, message}`', '`send_message` / mensagem direta `@worker`'],
    ['`TaskStop`', '`BOARD member kill`; o `swarm kill` nativo não vale para este board'],
    ['`disallowedTools: Edit, Write, NotebookEdit` do verifier', '`tools` explícito sem `edit_file` e `write_file`'],
    ['`/swarm`', '`/swarm-board` (o `/swarm` é o nativo)'],
    ...COMMON_ROWS,
  ],
  absent: [
    '`argument-hint` e `shell` no frontmatter da skill (só `name` e `description` são obrigatórios; `disable-model-invocation` não é documentado para skills de usuário)',
    'variável de diretório da skill e substituição de argumentos (a skill oficial de migração manda trocar o marcador de argumentos por uma instrução em texto)',
    'injeção de saída de comando dentro de skills',
  ],
  unverified: [
    'como `invoke_subagent` seleciona um agente customizado pelo nome',
    'se `send_message` chega aos agentes com `tools` explícito',
    'como encerrar um subagente por ferramenta',
    'o shell do `run_command` no Windows',
    'os nomes das tools de leitura e escrita (a skill local de migração e a página de subagentes divergem: read_file/edit_file/write_file contra view_file/replace_file_content/grep_search)',
    'o valor padrão de `tools` quando omitido (as fontes divergem: por isso a lista é sempre explícita)',
  ],
};

const profile = {
  id: 'antigravity',
  name: 'Antigravity',
  defaultSelected: false,
  verified: 'local',
  notes: [
    'AVISO: o Antigravity já tem um /swarm nativo (plugin embutido `swarm`). Este adapter vem desmarcado por padrão e instala como `swarm-board` (comando /swarm-board) para não colidir; use-o só se quiser este board em vez do nativo.',
    '~/.gemini/antigravity e ~/.gemini/config existem na máquina onde o instalador foi escrito (documentação local lida); o Antigravity não foi executado.',
    'Skill em ~/.gemini/config/skills/swarm-board e agentes em ~/.gemini/config/agents (project: <projeto>/.agents/skills e <projeto>/.agents/agents).',
    'O Gemini CLI também escreve em ~/.gemini/skills, pasta que o Antigravity CLI lê: instalar os dois pode mostrar uma skill `swarm` no Antigravity (não verificado como ele resolve a colisão).',
    'DIVERGÊNCIA de nomes de tools: a skill local de migração (migrate-agent-settings) usa read_file, edit_file, write_file, run_command, manage_task e search_web (a lista usada aqui, a que o relatório de pesquisa sustenta), mas a página antigravity.google/docs/subagents exemplifica view_file, replace_file_content, grep_search e run_command. Não afirmamos qual vale: se os nomes estiverem errados, o verifier pode ficar sem ferramenta de leitura.',
    'Não verificado: seleção de agente customizado em invoke_subagent, send_message com tools explícito, shell no Windows.',
    'O instalador não edita mcp_config.json, hooks.json nem plugins do Antigravity.',
  ],
  reads: {
    user: [['.gemini', 'config', 'skills'], ['.gemini', 'antigravity-cli', 'skills'], ['.gemini', 'skills'], ['.gemini', 'config', 'agents']],
    project: [['.agents', 'skills'], ['.agents', 'agents']],
  },
  skillName: 'swarm-board',
  agentExt: '.md',
  docs,
  // Só a frase de uso da descrição aponta o novo nome; a menção histórica ("Inspirado no /swarm do Google Antigravity") fica.
  descriptionTweaks: [['pedir /swarm,', 'pedir /swarm-board,']],

  markers: ({ home }) => [
    { dir: join(home, '.gemini', 'antigravity') },
    { dir: join(home, '.gemini', 'config') },
    { dir: join(home, '.gemini', 'antigravity-cli') },
  ],
  layout: ({ scope, home, cwd }) =>
    scope === 'user'
      ? { skills: join(home, '.gemini', 'config', 'skills'), agents: join(home, '.gemini', 'config', 'agents') }
      : { skills: join(cwd, '.agents', 'skills'), agents: join(cwd, '.agents', 'agents') },
  skillFrontmatter: ({ name, description }) => ({ name, description }),
  agentFile: ({ kind, name, description, body }) =>
    markdownAgent(
      {
        name,
        description,
        tools: kind === 'verifier' ? [...ANTIGRAVITY_VERIFIER_TOOLS] : [...ANTIGRAVITY_WORKER_TOOLS],
        subagent: true,
        mainAgent: false,
      },
      body,
    ),
  planNotes: () => [
    'Antigravity: instalado como /swarm-board; o /swarm sem sufixo continua sendo o swarm nativo. Rode /skills reload na TUI para carregar a skill.',
  ],
};

export const antigravity = createAdapter(profile);
