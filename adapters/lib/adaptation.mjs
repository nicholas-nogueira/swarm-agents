// Textos "Adaptação para <ferramenta>" que abrem a skill e cada agente gerados para ferramentas que não são o Claude Code.
// Tudo vem do perfil da ferramenta (profile.docs): este módulo só monta o Markdown. Nada aqui afirma além do que o
// relatório de pesquisa (tasks/research/harness-docs.md) comprova; o resto fica marcado como "não verificado".

const bullets = (items) => items.map((i) => `- ${i}`).join('\n');

/** Tabela Markdown de equivalências entre o Claude Code e a ferramenta. */
function mappingTable(tool, rows) {
  const esc = (s) => s.replaceAll('|', '\\|');
  const lines = [`| Claude Code | ${tool} |`, '|---|---|', ...rows.map(([a, b]) => `| ${esc(a)} | ${esc(b)} |`)];
  return lines.join('\n');
}

/**
 * Seção que abre o SKILL.md adaptado.
 * @param {object} profile perfil da ferramenta
 * @param {{boardPath: string, stateRoot: string}} ctx caminhos já em barra normal
 */
export function skillAdaptation(profile, ctx) {
  const { name: tool, docs } = profile;
  const board = `node "${ctx.boardPath}" --dir "${ctx.stateRoot}/<ID-DO-SWARM>"`;
  return `# Adaptação para ${tool}

Esta skill foi gerada pelo instalador swarm-agents a partir da versão do Claude Code. O texto mais abaixo foi escrito para o
Claude Code: **onde ele disser algo diferente desta seção, vale esta seção**. Nenhuma ferramenta foi executada na geração
deste arquivo (só leitura de documentação e de arquivos): o que estiver marcado "não verificado" não foi confirmado.

${bullets([
    `**Chamar a skill:** ${docs.invoke}`,
    '**Entrada do usuário:** é o texto que acompanha a chamada da skill (no Claude Code ela chegava numa variável de argumentos).',
    `**Board:** \`BOARD = ${board}\`. No começo escolha um ID de swarm (por exemplo \`swarm-AAAAMMDD-HHMM\`) e troque \`<ID-DO-SWARM>\` por ele em **todo** comando do board; os workers recebem o comando já pronto no brief. O estado fica em \`${ctx.stateRoot}/<ID>/\`.`,
    '**Primeiro passo:** rode `BOARD status` (no Claude Code o estado era injetado automaticamente). Se der erro, ainda não há swarm com esse ID.',
    '**Motor:** só `subagents`. Crie o swarm com `BOARD init --title "<título>" --backend subagents`. O motor `teams` é do Claude Code.',
    `**Criar um worker:** ${docs.spawn}`,
    `**Acordar quem foi mencionado:** ${docs.wake}`,
    `**Parar um worker:** ${docs.stop}`,
    `**Helpers e fork:** ${docs.helpers}`,
    `**Modelo e custo:** \`member add --tier\`, \`BOARD models\` e \`BOARD usage\` usam nomes de modelo e transcrições do Claude Code: não use. ${docs.model}`,
    `**Shell:** ${docs.shell}`,
    `**Verifier somente leitura:** ${docs.guard}`,
    '**Referência:** `references/backends.md` descreve o Claude Code (motores, `SendMessage`, `~/.claude`); aqui vale como contexto, não como instrução.',
  ])}

## Equivalências

${mappingTable(tool, docs.mapping)}

## O que não existe ou não foi verificado

${bullets([...docs.absent.map((x) => `Não existe/não encontrado: ${x}`), ...docs.unverified.map((x) => `Não verificado: ${x}`)])}

---

`;
}

/**
 * Seção que abre cada agente (worker ou verifier).
 * @param {object} profile
 * @param {'worker'|'verifier'} kind
 */
export function agentAdaptation(profile, kind) {
  const { name: tool, docs } = profile;
  const comuns = [
    '**Board:** use exatamente os comandos da sua primeira mensagem (`read --for`, `read --seqs`, `post --as`).',
    `**Shell:** ${docs.shell}`,
  ];
  const porPapel =
    kind === 'worker'
      ? [`**Ao ser acordado:** ${docs.agentWake}`, `**Helpers:** ${docs.agentHelpers}`]
      : [`**Somente leitura:** ${docs.guard}`, `**Ao ser acordado:** ${docs.agentWake}`];
  const aviso =
    kind === 'verifier'
      ? ' Onde o texto abaixo disser que as ferramentas de edição estão desligadas para você, vale o item "Somente leitura" desta seção.'
      : '';
  return `# Adaptação para ${tool}

Este agente foi gerado pelo instalador swarm-agents a partir da versão do Claude Code. Onde o texto abaixo citar ferramentas do
Claude Code (\`SendMessage\`, \`Agent\`, \`disallowedTools\`), vale esta seção. Nada foi executado em ${tool} na geração: o que
estiver marcado "não verificado" não foi confirmado.${aviso}

${bullets([...comuns, ...porPapel])}

---

`;
}
