# Limitações por ferramenta

Fonte: `harness-docs.md` (pesquisa de 2026-11-23, seção 7 "Mapa das primitivas" e seção 8 "Lacunas"). Legenda: OK = existe equivalente documentado; PARCIAL = existe com diferença relevante; NÃO = "não encontrado" na doc lida (não prova que não exista); "não verificado" = a página nem foi lida. Nenhuma ferramenta foi executada: tudo é leitura de documentação e de arquivos locais.

## O que muda em relação ao Claude Code

| Primitiva do /swarm (Claude Code) | Codex | Antigravity | Cursor | opencode | Gemini CLI |
|---|---|---|---|---|---|
| Skill `SKILL.md` com `name` e `description` | OK | OK | OK | OK | OK |
| Frontmatter extra `argument-hint`, `shell` | NÃO | não documentado | NÃO | NÃO | NÃO |
| Criar worker em background (`Agent` com `run_in_background`) | PARCIAL: subagentes paralelos por pedido em texto; background só na UI | OK: `invoke_subagent` e `/swarm` nativo | OK: `is_background: true` | OK: subagentes sempre em background (tool `subagent`) | PARCIAL: background não encontrado |
| Subagente nomeado (`swarm-worker`) | OK (`.codex/agents/*.toml`) | OK (`agents/*.md`) | OK (`.cursor/agents/*.md`) | OK (`agents/*.md`, `mode: subagent`) | OK (`.gemini/agents/*.md`) |
| `SendMessage` (acordar worker com histórico) | PARCIAL: sem nome de tool | OK: `send_message` | PARCIAL: só "resume" por agent ID | OK: `subagent` com `sessionID` | NÃO |
| `TaskStop` (matar worker) | NÃO | OK: `swarm{action:"kill"}` nativo | NÃO | NÃO | NÃO |
| Helpers (subagente de subagente) | não verificado | OK (limite 10 níveis) | PARCIAL (1 nível) | PARCIAL (profundidade padrão 1) | NÃO |
| Verifier sem Edit/Write (`disallowedTools`) | PARCIAL: sem lista de tools | PARCIAL: allowlist `tools`; padrão quando omitido diverge entre fontes | NENHUMA proteção técnica usada: `readonly: true` existe, mas poderia bloquear o `post` do board (não verificado); só instrução no texto | OK: `permissions` por agente | OK: `tools` (omitido herda tudo) |
| `model: inherit` | OK | OK | OK | OK (herda se omitido) | OK |
| Injeção de comando no corpo da skill | NÃO | NÃO | NÃO | só em commands | só em commands TOML |
| `$ARGUMENTS` | só em custom prompts deprecados | NÃO | NÃO | em commands | `{{args}}` em commands |
| `CLAUDE_SKILL_DIR` / `CLAUDE_SESSION_ID` | NÃO | NÃO | NÃO | NÃO | só em extension |
| Rodar `node board.mjs` | OK (shell exato não encontrado) | OK (`run_command`) | OK (shell no Windows não encontrado) | OK (tool `shell`; shell no Windows não encontrado) | OK (tool de shell não detalhada) |
| Slash command do usuário | skill invocável (`$skill`) | skill vira `/<nome>` | skill vira `/<nome>` | `@skill-id` e `/comando` | skills: não encontrado |

## Como o instalador contorna cada diferença

- **Injeção de comando e `CLAUDE_SKILL_DIR`**: nenhuma ferramenta documenta isso dentro de skills. O adapter grava o caminho absoluto do `board.mjs` instalado no texto da skill, e a injeção vira um primeiro passo explícito (rodar `board.mjs status`).
- **`CLAUDE_SESSION_ID`**: onde não existe, o coordenador escolhe um id no início (por exemplo `swarm-AAAAMMDD-HHMM`) e o reutiliza em todo comando do board.
- **`SendMessage`**: onde não há equivalente (Cursor, Codex, Gemini CLI), a alternativa é retomar por agent ID ("resume") ou criar um novo subagente com ponteiro para o `#seq` do board. O texto da skill instalada diz isso.
- **`TaskStop`**: onde não existe, não há como parar um worker pela skill; ele termina ao fim do turno.
- **Verifier somente leitura**: a proteção nunca pode impedir o `node board.mjs post`. Gemini CLI e Antigravity usam `tools` explícitos (com shell, de propósito); o opencode nega só a ação `edit` (inferência, não verificado). Cursor e Codex não têm proteção técnica: só instrução no texto do agente. Como o shell continua liberado, o verifier fora do Claude pode gravar arquivos por ele; só a regra do agente impede isso.

## Lacunas (não verificado)

Vêm da seção 8 do `harness-docs.md`:

- **Codex**: repositório e `docs/` não lidos; `~/.codex/skills` não aparece nas docs lidas (só `~/.agents/skills`); manifesto de plugin e `codex plugin` não encontrados; nomes das ferramentas de subagente não encontrados.
- **Cursor**: shell no Windows não encontrado; CLI para plugin não encontrado; `.cursor/commands` só confirmado por skill local.
- **opencode**: `OPENCODE_CONFIG_DIR` e lista exata de hooks não encontrados; shell padrão no Windows não encontrado; divergência de formato entre o `opencode.jsonc` local e a doc V2 (confira a versão instalada).
- **Antigravity**: nomes das ferramentas internas do `/swarm` só no `SKILL.md` local; `agy plugin install` com Git URL fora do GitHub não encontrado; o padrão de `tools` omitido diverge entre fontes (por isso `tools` é sempre declarado).
- **Gemini CLI**: background de subagente, slash command por skill e repositório GitHub não verificados. A doc avisa que o Gemini CLI foi substituído pelo Antigravity CLI em 18/06/2026.
- **Copilot, Windsurf (Devin Desktop) e Kiro**: documentados na pesquisa, não implementados na v1.
- O instalador não testa dentro das ferramentas: a conferência é só dos arquivos gerados.

## Modo interativo do instalador

Testado com entrada simulada (TTY simulado nos testes), mas não em terminal real. Sem cobertura: eco, Ctrl+C, Ctrl+D no meio da pergunta e CRLF no cmd e no PowerShell. Para conferir: rode `node bin/swarm-agents.mjs install` num terminal e veja a lista de seleção.

## Pasta de skills compartilhada

Quando duas ferramentas selecionadas leem a mesma pasta (ex.: Codex grava em `~/.agents/skills`, que Cursor, opencode e Gemini CLI também leem), o plano mostra ATENÇÃO; a instalação segue e nenhum destino muda. Qual skill vence quando há duas com o mesmo nome: não verificado. Detalhes em `installer/README.md`.

## Correção do lock do board (Windows)

- **O que era**: em `scripts/lib/store.mjs`, `withLock` só repetia a abertura do arquivo `.lock` quando o erro era `EEXIST`. No Windows, sob colisão de vários processos, a abertura exclusiva pode falhar com `EPERM` (e possivelmente `EBUSY`), e o post se perdia (cerca de 10% das rodadas de 20 posts em paralelo perdiam 1 post, medido pelo verifier).
- **O que mudou**: `EPERM` e `EBUSY` passam a ser tratados como contenção (mesmo backoff e mesmo timeout de 10 s). Se o tempo esgotar depois de um deles, a mensagem em pt-BR diz que pode ser contenção OU falta de permissão na pasta do swarm, e informa a pasta. `withLock` ganhou a opção `open` (padrão `openSync`) para permitir o teste. Teste novo: `tests/board/lock.test.mjs`.
- **Alcance**: é a única diferença do runtime em relação à versão que estava em `~/.claude` antes (baseline v1, `baseline-claude.v1-original.sha256` na pesquisa). O baseline v2 em `tests/golden/` difere do v1 só em `store.mjs`.
