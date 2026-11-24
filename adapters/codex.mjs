// Adapter do Codex (OpenAI Codex CLI). Fonte: harness-docs.md seção 1 (documentação oficial; ~/.codex não existe nesta
// máquina, então nada foi lido localmente). Skills em .agents/skills; subagentes são um arquivo TOML por agente em .codex/agents.
import { join } from 'node:path';
import { createAdapter } from './lib/factory.mjs';
import { COMMON_ROWS } from './lib/docs-common.mjs';
import { tomlMultiline, tomlString } from './lib/toml.mjs';

const docs = {
  invoke:
    'chame a skill pelo nome `swarm`. A documentação do Codex (lida só em resumo) cita `$<skill>` e `/plugins` na TUI; a sintaxe exata na sua versão: não verificado.',
  spawn:
    'o Codex cria subagentes por pedido em linguagem natural (por exemplo: "crie um subagente com o agente `swarm-worker` e este prompt: ..."). Os agentes `swarm-worker` e `swarm-verifier` foram instalados como TOML. Peça vários subagentes na mesma mensagem para rodarem em paralelo. Não há opção equivalente a `run_in_background` (a UI mostra os subagentes ativos acima do campo de texto). Os nomes das ferramentas de subagente (o repositório superpowers cita `spawn_agent` e `wait_agent`) não foram confirmados na documentação: não verificado.',
  wake: 'não há ferramenta nomeada para isso na documentação (ela cita só "routing follow-up instructions"). Peça ao Codex para encaminhar a continuação ao subagente existente; se não der, crie um subagente novo com o mesmo nome e mande rodar `BOARD read --for <nome>`: o cursor de leitura fica no board, por nome.',
  stop: 'não encontrado na documentação (não há `TaskStop`). Marque o membro com `BOARD member kill --name <nome>` e deixe o subagente terminar.',
  helpers:
    'subagente criando subagentes: não verificado, então trate o coordenador como único criador de agentes. `fork` não existe: crie o worker normal e aponte os `#seq` no brief.',
  model: 'O arquivo do agente não fixa `model` (campo opcional no Codex); o subagente usa o modelo que o Codex escolher.',
  shell:
    'o Codex roda no PowerShell nativo do Windows com sandbox; qual shell executa os comandos: não verificado. Os exemplos com heredoc (`<<\'EOF\'`) são de shell POSIX; em PowerShell envie o texto por pipe (`@\'...\'@ | node ...`).',
  guard:
    'não há bloqueio técnico de edição para um agente no Codex: o TOML do agente não tem campo `tools`, e `sandbox_mode`/`approval_policy` não são sobrescritos pelo arquivo do agente. A regra "não edite, só confira" vale como instrução e você a cumpre por conta própria.',
  agentWake:
    'ao ser acordado (ou recriado com o mesmo nome), rode `read --for <você>` antes de agir, pelo comando da sua primeira mensagem: o cursor de leitura fica no board.',
  agentHelpers: 'não crie helpers (subagente criando subagente: não verificado no Codex). Se a sua peça é grande, avise o coordenador pelo board.',
  mapping: [
    ['`Agent{subagent_type: "swarm-worker", prompt, run_in_background: true}`', 'pedido em linguagem natural de um subagente `swarm-worker` (TOML em `.codex/agents`); paralelo pedindo vários na mesma mensagem'],
    ['`SendMessage{to: <agent_id>, message}`', 'encaminhar instruções ao subagente (sem nome de ferramenta documentado) ou subagente novo com `BOARD read --for <nome>`'],
    ['`TaskStop`', 'não encontrado: `BOARD member kill`'],
    ['`disallowedTools: Edit, Write, NotebookEdit` do verifier', 'sem equivalente: só instrução no texto do agente'],
    ...COMMON_ROWS,
  ],
  absent: [
    '`argument-hint` e `shell` no frontmatter da skill (só `name` e `description` são documentados)',
    'variável de diretório da skill e injeção de saída de comando dentro de skills',
    'ferramenta nomeada para mandar mensagem a um subagente',
    'parar um subagente por ferramenta (`TaskStop`)',
    'lista de ferramentas por agente (`tools`) no TOML do agente',
  ],
  unverified: [
    'sintaxe de invocação da skill (`$swarm`)',
    'nomes das ferramentas de subagente',
    'o shell que executa os comandos no Windows',
    'se `.codex/agents/` do projeto exige projeto confiável',
    'se `~/.codex/skills` também é lido (a documentação lida só cita `~/.agents/skills`)',
  ],
};

const profile = {
  id: 'codex',
  name: 'Codex',
  defaultSelected: true,
  verified: 'doc',
  notes: [
    'Baseado só na documentação oficial: ~/.codex não existe na máquina onde o instalador foi escrito e o Codex não foi executado.',
    'Skill em ~/.agents/skills/swarm (project: <projeto>/.agents/skills/swarm); agentes TOML em ~/.codex/agents (project: <projeto>/.codex/agents).',
    'Não verificado: sintaxe de invocação da skill, nomes das ferramentas de subagente, shell no Windows, e se subagentes criam subagentes.',
    'Pasta compartilhada: ~/.agents/skills (e <projeto>/.agents/skills) também é lida por Cursor, opencode e Gemini CLI. Instalar o Codex junto com qualquer um deles pode mostrar duas skills `swarm` (cada uma com o texto adaptado a outra ferramenta); qual vence: não verificado. O plano declara as pastas lidas no campo `reads`.',
    'O instalador não edita config.toml, hooks nem AGENTS.md do Codex.',
  ],
  reads: {
    user: [['.agents', 'skills'], ['.codex', 'agents']],
    project: [['.agents', 'skills'], ['.codex', 'agents']],
  },
  skillName: 'swarm',
  agentExt: '.toml',
  docs,

  markers: ({ home, env }) => [{ dir: join(home, '.codex') }, ...(env.CODEX_HOME ? [{ dir: env.CODEX_HOME }] : [])],
  layout: ({ scope, home, cwd }) => {
    const base = scope === 'user' ? home : cwd;
    return { skills: join(base, '.agents', 'skills'), agents: join(base, '.codex', 'agents') };
  },
  skillFrontmatter: ({ name, description }) => ({ name, description }),
  agentFile: ({ name, description, body }) =>
    `name = ${tomlString(name)}\ndescription = ${tomlString(description)}\ndeveloper_instructions = ${tomlMultiline(body)}\n`,
};

export const codex = createAdapter(profile);
