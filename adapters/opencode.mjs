// Adapter do opencode. Fonte: harness-docs.md seção 4 (documentação oficial do opencode V2 + pasta local
// ~/.config/opencode, que existe nesta máquina) e a resposta do @harness-docs no board (#23) sobre `permissions`.
import { join } from 'node:path';
import { createAdapter, markdownAgent } from './lib/factory.mjs';
import { COMMON_ROWS } from './lib/docs-common.mjs';

const docs = {
  invoke:
    'o modelo chama a tool `skill`, ou você cita `@swarm` (o ID da skill vem do caminho da pasta, aqui `swarm`). Comandos `/...` do opencode são outra coisa (`commands/`); este instalador não cria nenhum.',
  spawn:
    'use a tool `subagent` (campos: id, description, prompt) com id `swarm-worker` ou `swarm-verifier` e o prompt impresso por `member add`. Subagentes sempre rodam em segundo plano. A chamada devolve um `sessionID`: guarde-o com `BOARD member update --name <nome> --agent-id <sessionID>`. Que o id do subagente seja o nome do arquivo (sem `.md`): não verificado, a documentação não diz literalmente.',
  wake: 'chame a tool `subagent` de novo passando o `sessionID` do worker: a conversa filha continua com o histórico (é o equivalente do `SendMessage`). Quando um filho fica ocioso, o pai recebe uma mensagem `<subagent>`.',
  stop: 'não encontrado na documentação (não há `TaskStop`). Use `BOARD member kill --name <nome>` e deixe o subagente terminar.',
  helpers:
    'a profundidade padrão de subagentes é 1 (`experimental.subagent_depth` muda isso): helpers só funcionam se o usuário aumentar o limite por conta própria, o instalador não edita a configuração. `fork` não existe: crie o worker normal e aponte os `#seq` no brief.',
  model: 'Os agentes não fixam `model`: o subagente herda o modelo do pai (documentação do opencode).',
  shell:
    'use a tool `shell` (`background: true` roda em segundo plano); qual é o shell padrão no Windows: não verificado. Os exemplos com heredoc (`<<\'EOF\'`) são de shell POSIX; em PowerShell envie o texto por pipe (`@\'...\'@ | node ...`).',
  guard:
    'o agente `swarm-verifier` tem `permissions` com `edit` negado (a action `edit` cobre as tools edit, write e patch). Só `edit` é negado, de propósito, para o shell (e o `post` do board) continuar liberado (que o shell fique liberado é inferência a partir da documentação: não verificado). O `deny` de `edit` não cobre comandos de shell, que gravam arquivos com a autoridade do usuário: você não edita nem pelo shell (sed, redirecionamento, scripts), só a regra garante isso.',
  agentWake: 'o pai retoma você pelo `sessionID` e a conversa continua com o histórico: ao ser acordado, rode `read --for <você>` antes de agir.',
  agentHelpers: 'só crie helpers se o limite `experimental.subagent_depth` da sua instalação permitir (padrão 1: não verificado). Na dúvida, avise o coordenador pelo board.',
  mapping: [
    ['`Agent{subagent_type: "swarm-worker", prompt, run_in_background: true}`', 'tool `subagent` com id `swarm-worker` (sempre em segundo plano; devolve `sessionID`)'],
    ['`SendMessage{to: <agent_id>, message}`', 'tool `subagent` com o `sessionID` do worker (continua a conversa filha)'],
    ['`TaskStop`', 'não encontrado: `BOARD member kill`'],
    ['`disallowedTools: Edit, Write, NotebookEdit` do verifier', '`permissions` com `action: edit`, `effect: deny`'],
    ...COMMON_ROWS,
  ],
  absent: [
    '`argument-hint` e `shell` no frontmatter da skill (existem `disable-model-invocation` e `metadata.opencode/autoinvoke`)',
    'variável de diretório da skill e injeção de saída de comando dentro de skills (a injeção com `!` só existe em `commands/`)',
    'parar um subagente por ferramenta (`TaskStop`)',
  ],
  unverified: [
    'a versão do opencode instalada: o formato dos agentes é o da V2 (`permissions`, `mode`); o `opencode.jsonc` local usa o formato anterior de `mcp`, então confira a versão antes de confiar nos agentes',
    'se o id do subagente é o nome do arquivo',
    'o shell padrão no Windows',
    'a combinação de `permissions` aplicada na prática: o exemplo exato (só `edit` negado, shell liberado) é uma inferência a partir da documentação',
  ],
};

const profile = {
  id: 'opencode',
  name: 'opencode',
  defaultSelected: true,
  verified: 'local',
  notes: [
    '~/.config/opencode existe na máquina onde o instalador foi escrito (opencode.jsonc e skills/ lidos); o formato dos agentes (V2) vem da documentação oficial. O opencode não foi executado.',
    'Skill em ~/.config/opencode/skills/swarm e agentes em ~/.config/opencode/agents (project: <projeto>/.opencode/...).',
    'Pasta compartilhada: ~/.agents/skills (e <projeto>/.agents/skills) também é lida por Codex, Cursor e Gemini CLI. Instalar o opencode junto com qualquer um deles pode mostrar duas skills `swarm` (cada uma com o texto adaptado a outra ferramenta); qual vence: não verificado. O plano declara as pastas lidas no campo `reads`.',
    'O opencode e o Cursor também carregam ~/.claude/skills: com o Claude Code instalado haverá duas skills `swarm`; qual vence: não verificado.',
    'Não verificado: versão do opencode do usuário (agentes V2 podem ser ignorados numa V1), id do subagente, shell no Windows.',
    '`permissions: edit deny` não impede o shell de gravar arquivos; que ele mantenha o shell (e o post do board) liberado é inferência da documentação: não verificado.',
    'O instalador não edita opencode.json(c) nem plugins.',
  ],
  reads: {
    user: [['.config', 'opencode', 'skills'], ['.claude', 'skills'], ['.agents', 'skills'], ['.config', 'opencode', 'agents']],
    project: [['.opencode', 'skills'], ['.claude', 'skills'], ['.agents', 'skills'], ['.opencode', 'agents']],
  },
  skillName: 'swarm',
  agentExt: '.md',
  docs,

  markers: ({ home }) => [{ dir: join(home, '.config', 'opencode') }],
  layout: ({ scope, home, cwd }) =>
    scope === 'user'
      ? { skills: join(home, '.config', 'opencode', 'skills'), agents: join(home, '.config', 'opencode', 'agents') }
      : { skills: join(cwd, '.opencode', 'skills'), agents: join(cwd, '.opencode', 'agents') },
  skillFrontmatter: ({ name, description }) => ({ name, description }),
  agentFile: ({ kind, description, body }) =>
    markdownAgent(
      {
        description,
        mode: 'subagent',
        ...(kind === 'verifier' ? { permissions: [{ action: 'edit', resource: '*', effect: 'deny' }] } : {}),
      },
      body,
    ),
};

export const opencode = createAdapter(profile);
