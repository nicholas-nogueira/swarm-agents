# Instalador e CLI `swarm-agents`

Instala a skill `/swarm` e os agentes `swarm-worker` e `swarm-verifier` nas ferramentas agênticas suportadas.
Zero dependências: só Node 24 e módulos `node:*`. Quem decide destino e conteúdo é cada adapter (`adapters/`);
o instalador é genérico e só grava o que o adapter planejou.

## Comandos

```
swarm-agents install [--client <id> ...] [--all-detected] [--scope user|project] [--yes] [--dry-run] [--force]
swarm-agents uninstall [--client <id> ...] [--scope user|project] [--yes] [--dry-run]
swarm-agents doctor
swarm-agents list
swarm-agents --help
```

- Sem argumentos, num terminal: escolha interativa das ferramentas (lista numerada; digite os números para
  marcar/desmarcar, `todos`, `nenhum`, Enter confirma), depois o escopo, o plano e a confirmação.
  Vêm pré-marcadas as ferramentas detectadas e marcadas por padrão (o Antigravity vem desmarcado).
- `--client` é repetível e validado contra a lista fechada de ids (`swarm-agents list`).
- `--all-detected` pega as ferramentas detectadas que são marcadas por padrão; as desmarcadas por padrão
  (Antigravity) ficam de fora e o comando diz como incluí-las (`--client antigravity`).
- `--scope`: `user` (padrão; grava sob a pasta pessoal) ou `project` (grava sob a pasta atual).
- `--yes` aplica sem perguntar. Sem terminal e sem `--yes`, o comando para e pede `--yes`.
- `--dry-run` mostra o mesmo plano e os mesmos avisos sem gravar nada (nem o manifesto).
- `--force` sobrescreve arquivo que existe, não é nosso e é diferente, guardando backup.

Códigos de saída: `0` ok, `1` erro (mensagem em pt-BR, sem stack), `2` conflito (também no `--dry-run`).

## Como a instalação funciona

1. **Plano**: para cada arquivo que o adapter planejou, uma operação: `criar` (não existe), `atualizar`
   (é nosso e mudou, ou `--force`), `sem mudança` (bytes iguais) ou `CONFLITO` (existe, não é nosso e difere;
   pasta ou link no lugar do arquivo é conflito que nem o `--force` resolve).
2. **Confirmação** (terminal) ou `--yes`.
3. **Transação por arquivo**: confere de novo o alvo, faz backup (`<arquivo>.swarm-agents.bak`; se já houver
   backup diferente, usa `.swarm-agents.bak.<sha12>`, nunca sobrescreve), grava de forma atômica (temporário +
   rename), relê e compara. Em qualquer falha, inclusive ao gravar o manifesto, desfaz tudo o que já tinha feito.
4. **Manifesto de propriedade** em `~/.swarm-agents/manifest.json` (`$SWARM_AGENTS_HOME/manifest.json` se
   definido): caminho, ferramentas, escopo, raiz e sha256 de cada arquivo, mais os diretórios criados. Só é
   regravado se mudou; reinstalar sem mudanças não escreve nada.

## Avisos de pasta compartilhada

Algumas ferramentas carregam skills de pastas de outras (ex.: o Codex grava em `~/.agents/skills`, que Cursor,
opencode e Gemini CLI também leem). Cada adapter informa no plano as pastas que a ferramenta carrega (`reads`).
Se um arquivo gravado pela ferramenta A fica numa pasta lida pela ferramenta B, ambas selecionadas, o plano mostra:

```
ATENÇÃO (pasta compartilhada entre ferramentas; os destinos não mudam, a instalação segue):
  - Cursor também lê <pasta> e verá os arquivos adaptados para Codex (N arquivo(s) de codex nessa pasta).
```

O aviso não falha a instalação nem muda destinos. Aparece igual com `--yes` e `--dry-run`; na confirmação
interativa ele é repetido logo antes da pergunta. Não há aviso quando as duas ferramentas gravam o mesmo arquivo
com conteúdo idêntico (cada uma vê o próprio conteúdo); conteúdos diferentes no mesmo arquivo são recusados.

## Desinstalação

Remove só o que o manifesto registra, que ainda está dentro da raiz registrada, é arquivo comum (não link) e
cujo sha256 ainda bate. Arquivo modificado por você é mantido (e sai do manifesto). Arquivo compartilhado entre
ferramentas só é desvinculado da ferramenta pedida. Diretórios só são apagados se foram criados pelo instalador
e ficaram vazios. Backups `.swarm-agents.bak` são preservados.

## Segurança

- `--client` e `--scope` validados contra listas fechadas; a entrada nunca é ecoada inteira.
- Todo destino precisa ser absoluto e ficar dentro do home (escopo user) ou do cwd (escopo project); caminho que
  passa por link para fora da raiz, ou destino que é link, é recusado.
- O instalador nunca lê nem edita arquivo de configuração das ferramentas (MCP, settings, hooks) e nunca escreve
  conteúdo de arquivo no log, só caminhos e operações.

## Diagnóstico

`swarm-agents doctor` confere a versão do Node (mínimo 24), o payload, o manifesto e, por ferramenta instalada,
se os arquivos estão presentes, intactos e atuais em relação a esta versão (saída `0` se não houver erro).

## Testes

- `tests/installer/`: unitários e funcionais do engine e da CLI com adapters falsos e streams simulados.
- `tests/e2e/`: a CLI real (`bin/swarm-agents.mjs`) em processo filho com os adapters e o payload reais, HOME e
  cwd temporários. Prova que o Claude instalado é byte-idêntico ao `tests/golden/baseline-claude.sha256` atual.
