# /swarm: motores e mapeamento a partir do Antigravity

## De onde veio

O `/swarm` do Google Antigravity está em Preview. A implementação de referência estudada:
- a skill do coordenador em `~/.gemini/antigravity/builtin/skills/native_swarm/SKILL.md`, mais `swarm_monitor` e `swarm_pane`;
- o backend Go `nativeswarm` dentro de `~/.gemini/bin/agy.exe`, analisado com o REA: ferramentas `swarm`, `post_message`,
  `read_board` e `swarm_wait`, o prompt `<swarm_worker>` e os pacotes `board/`, `wake/` e `filestore/`;
- a documentação oficial em https://antigravity.google/docs/swarm.

| Antigravity | Aqui |
|---|---|
| `swarm{action:"add", name, brief}` | `BOARD member add` (publica `@nome <brief>`) + `Agent` em background |
| `swarm{action:"add", n / tasks}` | `member add --n K`, que cria `nome-1..nome-K` |
| `swarm{action:"kill"}` | `TaskStop` + `member kill` (permanente; o nome não volta) |
| `swarm{action:"status"}` | `BOARD status` |
| `post_message` / `read_board{since, seqs, limit}` | `BOARD post --as` / `BOARD read --for/--since/--seqs/--limit` |
| `swarm_wait` (dormir até ser chamado) | encerrar o turno; o coordinator acorda o membro com `SendMessage` |
| park guard (não deixa dormir com menção não lida) | `BOARD pending`, conferido a cada notificação |
| `workspace:"share"` | `member add --workspace share` / `workspace share` (worktree com o estado local) |
| integrar antes do kill | `workspace land` (cherry-pick sem commit) + `workspace remove` |
| `fork:"coordinator"` | `Agent{subagent_type:"fork"}` |
| monitor (cron de travamento) | desnecessário: o harness sempre notifica; `status` mostra o diagnóstico |
| narrator / painel do Swarm | `/swarm board` (`BOARD render`) |
| canais `#area` | fora do escopo: o coordinator roteia, então não há broadcast caro |

## Motor `subagents` (padrão, estável)

- Cada membro é um subagente em background (`swarm-worker` ou `swarm-verifier`). Ao terminar a vez, ele notifica o
  coordinator, que é o único que o acorda de novo (`SendMessage` para o `agent_id`; ele retoma com o histórico inteiro).
- Workers não se acordam entre si. Eles postam no board e o coordinator, guiado pelo `pending`, toca a campainha.
  Isso troca um pouco de latência por um roteamento previsível.
- Helpers aninhados funcionam (até 3 níveis por padrão). Até 20 subagentes rodam ao mesmo tempo
  (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).
- O `isolation: "worktree"` nativo **não** é usado: ele parte do branch padrão e perde o estado não commitado. O
  `workspace share` replica o Antigravity: copia o index, faz `git add -A` num index temporário, `write-tree`,
  `worktree add -b`, `read-tree -u --reset` e grava um commit-base com o snapshot.

## Motor `teams` (quando `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)

- O Agent com `name` vira teammate, e os teammates trocam `SendMessage` diretamente. O protocolo continua igual: o
  board é o registro (com `#seq`) e o `SendMessage` é só a campainha (`board #12`).
- O lead recebe uma idle notification com a resposta final de cada teammate.
- Limitações documentadas: experimental; sem `/resume` dos teammates; uma equipe por sessão; teammates não criam
  teammates; sem permissão por teammate na criação. Passar `isolation` no Agent faz dele um subagente, não um teammate.
- Para ligar: `"env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }` em `~/.claude/settings.json` (vale para sessões novas).

## Arquivos

- Estado: `~/.claude/swarm/<session-id>/board.jsonl` (`{seq, agent, text, time, mentions}` por linha) e `members.json`
  (`{title, backend, members:{nome:{role, state, agent_id, parent, workspace, workspace_path, branch, base, brief_seq, last_read_seq}}}`).
- Worktrees: `~/.claude/swarm/<session-id>/wt/<nome>`, no branch `swarm/<id>/<nome>`.
- Regras de nome: `^[a-z0-9][a-z0-9_-]*$`, até 24 caracteres; `all`, `coordinator` e `coordinator-*` são reservados.
- Menções: `@nome` em início de palavra, sem diferenciar maiúsculas e sem mais caracteres de nome depois (`board/mentions.go`);
  `@prefixo` chama `prefixo-N`.
- Testes: `npm test` nesta pasta (node:test; unit, funcional e integração, com cobertura mínima de 90%).
