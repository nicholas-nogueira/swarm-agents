# Adapters

Um adapter decide **onde** e **com que conteúdo** a skill `/swarm` e os dois agentes (`swarm-worker`, `swarm-verifier`) são
instalados numa ferramenta agêntica. O adapter só **planeja**; quem grava, faz backup, confere e desfaz é o instalador
(`installer/`). Nenhum adapter lê nem edita arquivo de configuração das ferramentas (`mcp.json`, `settings.json`,
`config.toml`, `opencode.jsonc`, hooks): a skill não usa MCP e o `~/.cursor/mcp.json` do usuário pode ter segredo.

## Contrato

`adapters/index.mjs` exporta `ADAPTERS` (id -> adapter), `listAdapters()` e `getAdapter(id)`. Cada adapter:

```js
{
  id, name,
  defaultSelected,           // boolean
  verified,                  // "native-claude" | "local" | "doc"
  notes,                     // string[]: o que não foi verificado e avisos
  detect({ home, cwd, env }) // boolean (só olha se a pasta/arquivo da ferramenta existe)
  plan({ scope, home, cwd, payload }) // { files: [{ path (absoluto), content (string | Buffer) }], notes: string[], reads: string[] }
}
```

- `scope` é `user` ou `project` (qualquer outro valor falha com `ESCOPO_INVALIDO`); `home` e, no escopo project, `cwd` precisam ser absolutos.
- `payload` é o `Map` relPath -> `Buffer` de `installer/payload.mjs` (`skills/swarm/**` e `agents/*`). Payload incompleto falha com `PAYLOAD_INCOMPLETO` e SKILL.md de outra versão com `PAYLOAD_INCOMPATIVEL`, ambos com mensagem em pt-BR.
- Todo caminho planejado fica **dentro** de `home` (user) ou `cwd` (project): nada de `CODEX_HOME`, `GEMINI_CLI_HOME` etc. apontando para fora.
- `reads`: caminhos absolutos das pastas de skill e de agente que a ferramenta **carrega** (user e, com `cwd` absoluto, project), segundo o `harness-docs.md`: `~/.agents/skills` no Codex, Cursor, opencode e Gemini; `~/.claude/skills` e `~/.claude/agents` também no Cursor (e `~/.claude/skills` no opencode); `~/.gemini/skills` e `~/.gemini/antigravity-cli/skills` no Antigravity CLI. O adapter **só declara**; o aviso de pasta compartilhada é do instalador.
- As chaves do payload são validadas antes de virarem caminho: relativas, sem `..`, `.`, segmento vazio, barra invertida, raiz, letra de unidade ou byte nulo (`PAYLOAD_INCOMPATIVEL`).
- Erros são `AdapterError` (`adapters/lib/errors.mjs`) com `code` estável.

## O que cada adapter faz

| id | verified | padrão | skill (user) | agentes (user) | formato do agente |
|---|---|---|---|---|---|
| `claude` | native-claude | marcado | `~/.claude/skills/swarm/` | `~/.claude/agents/*.md` | idêntico ao atual (bytes do payload, sem transformação) |
| `codex` | doc | marcado | `~/.agents/skills/swarm/` | `~/.codex/agents/swarm-*.toml` | TOML: `name`, `description`, `developer_instructions` |
| `cursor` | local | marcado | `~/.cursor/skills/swarm/` | `~/.cursor/agents/swarm-*.md` | Markdown: `name`, `description`, `model: inherit`, `is_background: true` (verifier sem `readonly`, ver abaixo) |
| `opencode` | local | marcado | `~/.config/opencode/skills/swarm/` | `~/.config/opencode/agents/swarm-*.md` | Markdown V2: `description`, `mode: subagent`, verifier com `permissions` (`edit` deny) |
| `gemini` | local | marcado | `~/.gemini/skills/swarm/` | `~/.gemini/agents/swarm-*.md` | Markdown: `name`, `description`, `model: inherit`, verifier com `tools` só de leitura e shell |
| `antigravity` | local | **desmarcado** | `~/.gemini/config/skills/swarm-board/` | `~/.gemini/config/agents/swarm-*.md` | Markdown: `name`, `description`, `tools` explícito, `subagent: true`, `mainAgent: false` |

No escopo `project` as mesmas pastas ficam em `<cwd>`: `.agents/skills` + `.codex/agents` (Codex), `.cursor/` (Cursor),
`.opencode/` (opencode), `.gemini/` (Gemini CLI), `.agents/skills` + `.agents/agents` (Antigravity) e `.claude/` (Claude).

`verified` significa: `native-claude` = é o comportamento que já funciona; `local` = a pasta da ferramenta existe na máquina
onde o instalador foi escrito e a estrutura foi lida (o formato dos agentes ainda vem da documentação); `doc` = só a
documentação oficial sustenta (o Codex não está instalado nessa máquina).

### O que muda no SKILL.md fora do Claude

`adapters/lib/factory.mjs` troca quatro construções (as três primeiras falham alto se sumirem do SKILL.md, em vez de gerar uma skill quebrada) e depois confere que não sobrou nenhum resquício do Claude:

1. a definição `BOARD = node ... --session ...` vira `BOARD = node "<caminho absoluto instalado>/scripts/board.mjs" --dir "<home>/.swarm-agents/swarm/<ID-DO-SWARM>"`: o coordenador escolhe um ID no início (`swarm-AAAAMMDD-HHMM`) e o reutiliza em todo comando;
2. a injeção de saída de comando (linha "Estado atual") vira um primeiro passo explícito: rodar `BOARD status`;
3. a injeção do "Motor" vira `subagents` fixo (`BOARD init ... --backend subagents`);
4. a entrada do usuário e as referências a `~/.claude/agents/swarm-*.md` passam a apontar para o que foi instalado.

Antes do texto original entra a seção **"Adaptação para &lt;ferramenta&gt;"** (`adapters/lib/adaptation.mjs`): como criar um worker, como
acordar quem foi mencionado, como parar, helpers, shell, proteção do verifier, uma tabela de equivalências Claude Code -> ferramenta, e a lista do que
**não existe** ou **não foi verificado**. Onde o texto do Claude disser outra coisa, vale essa seção. O frontmatter perde `argument-hint` e `shell`
(nenhuma ferramenta os documenta), e a descrição é escrita entre aspas para sobreviver ao YAML (`#seq`, `:`).

Os demais arquivos da skill (`scripts/`, `models.json`, `package.json`, `references/`) vão **byte a byte**. O estado dos boards fora do Claude fica em
`<home>/.swarm-agents/swarm/<ID>/`, para não criar `~/.claude` em quem não usa o Claude Code. `BOARD usage` e `--tier` são do Claude Code (leem transcrições
e usam nomes de modelo dele) e a adaptação manda não usar.

### Proteção do verifier (somente leitura)

| ferramenta | proteção | limite |
|---|---|---|
| Claude | `disallowedTools: Edit, Write, NotebookEdit` | o shell ainda grava (regra no texto) |
| Codex | **nenhuma verificada** (sem campo `tools` no TOML) | só instrução |
| Cursor | **nenhuma técnica**: `readonly: true` não é usado porque pode impedir o `post` no board (não verificado) | só instrução no texto do agente: não edita arquivos do projeto, só escreve no board |
| opencode | `permissions` com `edit` deny (shell liberado: inferência, não verificado) | `edit` deny não cobre o shell |
| Gemini CLI | `tools` explícito (leitura + `run_shell_command`) | o shell ainda grava |
| Antigravity | `tools` explícito sem `edit_file`/`write_file` | `run_command` ainda grava |

## Antigravity: já existe um /swarm nativo

O Antigravity traz um plugin `swarm` nativo. Por isso o adapter vem **desmarcado**, instala a skill como `swarm-board` (comando `/swarm-board`) e avisa. O Gemini CLI
também escreve em `~/.gemini/skills`, que o Antigravity CLI lê: instalar os dois pode mostrar a skill `swarm` no Antigravity (não verificado como ele resolve).

## Não implementados na v1

GitHub Copilot, Windsurf (hoje Devin Desktop) e Kiro: estão documentados em `tasks/research/harness-docs.md`, mas não têm adapter.

## O que NÃO foi possível testar

**Nenhuma das ferramentas foi executada.** Não há como rodar Codex, Cursor, opencode, Gemini CLI ou Antigravity dentro dos testes. Os testes
(`tests/adapters/`) provam o que dá para provar sem elas: caminhos por escopo, frontmatter/TOML bem formados (com ida e volta por um parser mínimo),
ausência de `CLAUDE_SKILL_DIR`/`CLAUDE_SESSION_ID`, caminho do board correto, idempotência, cenários negativos, e que o Claude sai idêntico à linha de base
(sha256 contra `tests/golden/baseline-claude.sha256`). Se a ferramenta carrega o arquivo e se o modelo segue a adaptação só se vê usando. Tudo que a
documentação lida não confirma está marcado **"não verificado"** nas `notes` de cada adapter e dentro dos arquivos gerados. Os principais:

- Codex: sintaxe de invocação da skill, nomes das ferramentas de subagente, shell no Windows, confiança de `.codex/agents` em projeto.
- Cursor: se `readonly: true` bloquearia o `post` do board (por isso não é usado); qual skill vence quando `~/.claude/skills` e `~/.cursor/skills` coexistem.
- opencode: versão instalada (o formato é o da V2), id do subagente, combinação exata de `permissions`.
- Gemini CLI: subagentes em segundo plano, slash command da skill, nomes das ferramentas de escrita.
- Antigravity: **nomes das tools** (a skill local de migração usa `read_file`/`edit_file`/`write_file`; a página de subagentes exemplifica `view_file`/`replace_file_content`/`grep_search`; não afirmamos qual vale), seleção de agente customizado em `invoke_subagent`, `send_message` com `tools` explícito.

## Como adicionar uma ferramenta

1. Crie `adapters/<id>.mjs` com um perfil (`docs`, `layout`, `markers`, `skillFrontmatter`, `agentFile`, `notes`) e `createAdapter(perfil)`; veja `cursor.mjs`.
2. Registre em `adapters/index.mjs` e adicione os marcadores de `detect` em `tests/adapters/contract.test.mjs`.
3. Escreva primeiro os testes de caminho e formato em `tests/adapters/adapters.test.mjs`. Só afirme no `docs` o que a documentação comprova; o resto é "não verificado".

## Testes

```
node --test tests/adapters/*.test.mjs
node --test --experimental-test-coverage --test-coverage-include="adapters/**" tests/adapters/*.test.mjs
```
