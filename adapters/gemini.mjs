// Adapter do Gemini CLI. Fontes: harness-docs.md seção 5 (documentação oficial + ~/.gemini local, que existe nesta máquina),
// resposta do @harness-docs no board (#23) sobre o frontmatter de subagente e os nomes de ferramenta do material do
// superpowers citado em sp-harnesses.md (references/gemini-tools.md).
import { join } from 'node:path';
import { createAdapter, markdownAgent } from './lib/factory.mjs';
import { COMMON_ROWS } from './lib/docs-common.mjs';

/** Ferramentas de leitura + shell do verifier (nomes do gemini-tools.md do superpowers; a página de subagentes só mostra read_file e grep_search). */
export const GEMINI_VERIFIER_TOOLS = Object.freeze(['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory', 'run_shell_command']);

const docs = {
  invoke:
    'o Gemini CLI ativa skills pela ferramenta `activate_skill` (pede confirmação): peça "use a skill swarm". Comando `/swarm` por skill: não verificado (slash commands do Gemini são arquivos TOML em `commands/`, que este instalador não cria).',
  spawn:
    'use `invoke_agent` com `agent_name: "swarm-worker"` (ou `"swarm-verifier"`) e o prompt impresso por `member add`; digitar `@swarm-worker <prompt>` é equivalente. Várias chamadas `invoke_agent` na mesma resposta são o caminho para trabalhar em paralelo. Execução em segundo plano: não encontrado na documentação, então trate cada chamada como bloqueante até o subagente terminar a vez.',
  wake: 'não existe mensagem a um subagente (não encontrado na documentação). Para acordar quem foi mencionado, chame `invoke_agent` de novo com o mesmo agente e o prompt "rode `BOARD read --for <nome>` e continue": o cursor de leitura fica no board, por nome. Retomar o histórico da conversa do subagente: não documentado.',
  stop: 'não encontrado na documentação. Use `BOARD member kill --name <nome>`.',
  helpers:
    'a documentação diz que subagentes não podem chamar outros subagentes: workers não criam helpers, só o coordenador cria agentes. `fork` não existe: crie o worker normal e aponte os `#seq` no brief.',
  model: 'Os agentes usam `model: inherit`.',
  shell:
    'a ferramenta de shell é `run_shell_command` (nome vindo do material do superpowers para o Gemini CLI; confirmações e shell no Windows: não verificado). Os exemplos com heredoc (`<<\'EOF\'`) são de shell POSIX; em PowerShell envie o texto por pipe (`@\'...\'@ | node ...`).',
  guard: `o agente \`swarm-verifier\` tem \`tools\` explícito só com leitura e shell (${GEMINI_VERIFIER_TOOLS.join(', ')}), sem \`write_file\` nem \`replace\`, e com \`run_shell_command\` incluído de propósito para o \`post\` do board nunca ser impedido. O shell ainda pode gravar arquivos: você não edita nem pelo shell (sed, redirecionamento, scripts), só a regra garante isso.`,
  agentWake: 'você pode ser chamado de novo sem o histórico da conversa anterior: ao ser acordado, rode `read --for <você>` antes de agir, pelo comando da sua primeira mensagem.',
  agentHelpers: 'não crie helpers: no Gemini CLI subagentes não chamam outros subagentes. Se a sua peça é grande, avise o coordenador pelo board.',
  mapping: [
    ['`Agent{subagent_type: "swarm-worker", prompt, run_in_background: true}`', '`invoke_agent` com `agent_name: "swarm-worker"` (ou `@swarm-worker <prompt>`); segundo plano não encontrado'],
    ['`SendMessage{to: <agent_id>, message}`', 'não existe: nova chamada `invoke_agent` mandando rodar `BOARD read --for <nome>`'],
    ['`TaskStop`', 'não encontrado: `BOARD member kill`'],
    ['`disallowedTools: Edit, Write, NotebookEdit` do verifier', '`tools` com lista explícita de leitura e shell'],
    ...COMMON_ROWS,
  ],
  absent: [
    '`argument-hint` e `shell` no frontmatter da skill (só `name` e `description` são documentados)',
    'variável de diretório da skill e injeção de saída de comando dentro de skills (a injeção `!{...}` só existe em commands TOML)',
    'mensagem a um subagente existente',
    'subagente chamando subagente',
    'parar um subagente por ferramenta (`TaskStop`)',
  ],
  unverified: [
    'se os subagentes estão ligados na sua instalação (a documentação cita `experimental.enableAgents`; o instalador não edita settings.json)',
    'execução de subagentes em segundo plano',
    'slash command `/swarm` para skills',
    'os nomes das ferramentas de escrita e de shell na página de subagentes (vêm do material do superpowers)',
    'o shell padrão no Windows',
  ],
};

const profile = {
  id: 'gemini',
  name: 'Gemini CLI',
  defaultSelected: true,
  verified: 'local',
  notes: [
    '~/.gemini (settings.json e skills/) existe na máquina onde o instalador foi escrito; o formato dos subagentes vem da documentação oficial. O Gemini CLI não foi executado.',
    'Skill em ~/.gemini/skills/swarm e agentes em ~/.gemini/agents (project: <projeto>/.gemini/...).',
    'Pasta compartilhada: ~/.agents/skills (e <projeto>/.agents/skills) também é lida por Codex, Cursor e opencode. Instalar o Gemini CLI junto com qualquer um deles pode mostrar duas skills `swarm` (cada uma com o texto adaptado a outra ferramenta); qual vence: não verificado. O plano declara as pastas lidas no campo `reads`.',
    'O Antigravity CLI também lê ~/.gemini/skills: com os dois instalados a skill `swarm` aparece no Antigravity e pode colidir com o /swarm nativo dele (não verificado como ele resolve).',
    'A documentação avisa que o Gemini CLI foi substituído pelo Antigravity CLI em 18/06/2026 para os planos gratuito e Google One.',
    'Não verificado: subagentes em segundo plano, slash command da skill, shell no Windows, nomes das ferramentas de escrita.',
    'O instalador não edita ~/.gemini/settings.json (mcpServers) nem GEMINI.md.',
  ],
  reads: {
    user: [['.gemini', 'skills'], ['.agents', 'skills'], ['.gemini', 'agents']],
    project: [['.gemini', 'skills'], ['.agents', 'skills'], ['.gemini', 'agents']],
  },
  skillName: 'swarm',
  agentExt: '.md',
  docs,

  markers: ({ home }) => [{ file: join(home, '.gemini', 'settings.json') }, { file: join(home, '.gemini', 'GEMINI.md') }],
  layout: ({ scope, home, cwd }) => {
    const base = join(scope === 'user' ? home : cwd, '.gemini');
    return { skills: join(base, 'skills'), agents: join(base, 'agents') };
  },
  skillFrontmatter: ({ name, description }) => ({ name, description }),
  agentFile: ({ kind, name, description, body }) =>
    markdownAgent({ name, description, ...(kind === 'verifier' ? { tools: [...GEMINI_VERIFIER_TOOLS] } : {}), model: 'inherit' }, body),
};

export const gemini = createAdapter(profile);
