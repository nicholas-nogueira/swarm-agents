# swarm-agents

A skill `/swarm` (vários agentes em paralelo numa mesma tarefa, cada um na própria conversa, colaborando por um board compartilhado com `@menções`) mais um instalador que deixa você escolher em quais ferramentas agênticas instalá-la.

Hoje a skill nasceu no Claude Code. Este repositório empacota os mesmos arquivos (o `payload/`) e gera, para cada outra ferramenta, a versão no formato nativo dela.

> Zero dependências de runtime: Node 24 e só módulos `node:*`.

## Regra de ouro: o Claude Code não muda

Para o Claude Code o resultado instalado é idêntico, byte a byte, ao que já existia em `~/.claude`. O teste `tests/golden/golden.test.mjs` compara o `payload/` com a linha de base `tests/golden/baseline-claude.sha256` e falha se um único byte divergir.

## Ferramentas

| Id | Ferramenta | Padrão | Fonte dos fatos | Observação |
|---|---|---|---|---|
| `claude` | Claude Code | marcado | `native-claude` (arquivos locais que já funcionam) | Identidade: copia o payload sem tocar no conteúdo. |
| `codex` | OpenAI Codex CLI | marcado | `doc` (só documentação; `~/.codex` não existia na máquina da pesquisa) | Subagente em TOML. Vários pontos "não verificado" (ver `docs/limitations.md`). |
| `cursor` | Cursor | marcado | `local` (estrutura de `~/.cursor` lida) | Verifier sem `readonly` (poderia bloquear o `post` do board; só instrução no texto). |
| `opencode` | opencode | marcado | `local` (estrutura de `~/.config/opencode` lida) | A doc descreve a "V2"; confira a versão instalada. |
| `gemini` | Gemini CLI | marcado | `local` (estrutura de `~/.gemini` lida) | A doc avisa que o Gemini CLI foi substituído pelo Antigravity CLI em 18/06/2026. |
| `antigravity` | Google Antigravity | **desmarcado** | `local` | Veja o aviso abaixo. Instala com o nome `swarm-board`. |

Os valores finais de `verified` e as notas de cada ferramenta saem de `node bin/swarm-agents.mjs list` (a fonte é cada adapter em `adapters/`; em caso de divergência com esta tabela, vale o adapter). Nenhuma ferramenta foi executada para testar na prática: tudo é leitura de documentação oficial e de arquivos locais, e cada ponto sem confirmação está marcado "não verificado" no código e em `docs/limitations.md`.

"Marcado" significa pré-selecionado no multiselect interativo; com `--all-detected` só entram as ferramentas detectadas na máquina.

### Aviso sobre o Antigravity

O Antigravity já tem um `/swarm` nativo (plugin embutido `swarm`). Instalar o nosso lá duplicaria o recurso e colidiria no nome. Por isso o alvo fica selecionável, mas desmarcado por padrão, e instala sob o nome `swarm-board`. Marque-o só se quiser mesmo as duas versões lado a lado.

## Instalar

Exige Node 24 ou superior.

```bash
# a partir de um clone deste repositório
git clone https://github.com/nicholas-nogueira/swarm-agents.git
cd swarm-agents
node bin/swarm-agents.mjs install
```

> **Atenção:** este pacote ainda **não está publicado no npm**. O nome `swarm-agents` no npm pertence a outro projeto, então **não rode `npx swarm-agents`**: isso executaria código de terceiros. Use o clone acima.

Sem flags e num terminal interativo, o instalador mostra um multiselect das ferramentas e pergunta o escopo:

- `user` (padrão): instala na pasta pessoal da ferramenta (`~/...`), como o uso de hoje.
- `project`: instala dentro do diretório atual.

Modo não interativo:

```bash
node bin/swarm-agents.mjs install --client claude --client cursor --scope user --yes
node bin/swarm-agents.mjs install --all-detected --scope project --dry-run
```

| Comando | O que faz |
|---|---|
| `install [--client X ...] [--all-detected] [--scope user\|project] [--yes] [--dry-run] [--force]` | Planeja e grava os arquivos. |
| `uninstall` | Remove só o que o manifesto registra e cujo conteúdo ainda bate com o instalado. |
| `doctor` | Confere se os arquivos instalados existem e batem com o manifesto. |
| `list` | Lista as ferramentas, o que é verificado e o que não é. |

Garantias do instalador:

- `--dry-run` mostra o plano (alvo, operação, backup) e não grava nada.
- Escrita atômica, leitura de conferência após gravar e rollback se algo falhar.
- Idempotente por bytes: rodar de novo sem mudanças resulta em `unchanged`.
- Conflito (o destino existe, não é nosso e é diferente): recusa com código de saída 2. Com `--force`, faz backup `.swarm-agents.bak` antes de sobrescrever.
- O manifesto de propriedade fica em `<home>/.swarm-agents/manifest.json` (a variável `SWARM_AGENTS_HOME` muda o local).
- O instalador só escreve arquivos de skill e de agente. **Nunca lê nem edita arquivos de configuração das ferramentas** (por exemplo `mcp.json`, `settings.json`, `config.toml`), porque eles podem ter segredos.
- Quando duas ferramentas selecionadas compartilham uma pasta de skills (ex.: Codex grava em `~/.agents/skills`, que Cursor, opencode e Gemini CLI também leem), o plano mostra um aviso ATENÇÃO; a instalação segue sem mudar destinos. Detalhes: `installer/README.md`.
- O backup `.swarm-agents.bak` criado por `--force` não é apagado pelo `uninstall`.
- Ids de ferramenta e escopo são validados, e destinos fora da pasta esperada ou via symlink para fora são recusados.

## Desinstalar

```bash
node bin/swarm-agents.mjs uninstall
```

Arquivos que você editou depois da instalação não são apagados: o conteúdo precisa bater com o registrado no manifesto.

## Adicionar uma ferramenta nova

Veja `docs/adding-a-tool.md`.

## Ferramentas não implementadas na v1

Documentadas na pesquisa, mas fora desta versão:

- GitHub Copilot (VS Code e CLI): não implementado
- Windsurf (hoje Devin Desktop): não implementado
- Kiro: não implementado

## Limitações

O que não tem equivalente em cada ferramenta (sem `SendMessage`, sem `TaskStop`, sem injeção de comando em skill etc.) está em `docs/limitations.md`.

O modo interativo foi testado com entrada simulada, mas não em terminal real. Sem cobertura: eco, Ctrl+C, Ctrl+D no meio da pergunta e CRLF no cmd e no PowerShell. Para conferir, rode `node bin/swarm-agents.mjs install` num terminal e veja a lista de seleção.

## Correção do lock do board (Windows)

O runtime da skill tem uma única diferença em relação à versão que estava em `~/.claude` antes deste repositório (baseline v1): `store.mjs` agora trata `EPERM` e `EBUSY` como contenção do lock. Detalhes em `docs/limitations.md`.

## Desenvolvimento

```bash
npm test               # todos os testes (node:test)
npm run test:coverage  # com cobertura e limites (linhas 90, ramos 80, funções 90)
```

Estrutura:

```
payload/      cópia byte-idêntica da skill e dos agentes do Claude Code
adapters/     um adapter por ferramenta (decide caminhos e conteúdo)
installer/    engine genérico (plano, backup, escrita atômica, manifesto)
bin/          CLI swarm-agents
tests/        board/ (testes da skill), golden/, payload/, adapters/, installer/, e2e/
docs/         guias e limitações
```

Todo teste usa HOME e diretório de trabalho temporários; nada é instalado no HOME real.

## Licença

MIT. Veja o arquivo [`LICENSE`](LICENSE).
