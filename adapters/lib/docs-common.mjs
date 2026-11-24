// Linhas da tabela de equivalências que valem igualmente para todas as ferramentas que não são o Claude Code.
export const COMMON_ROWS = Object.freeze([
  ['`Agent{subagent_type: "fork"}`', 'não existe: crie um worker normal e aponte os `#seq` relevantes no brief'],
  ['`--tier`, `BOARD models`, `BOARD usage`', 'não use: são nomes de modelo e transcrições do Claude Code'],
  ['motor `teams`', 'não existe: use `--backend subagents`'],
  ['variável de diretório da skill e injeção de saída de comando no corpo da skill', 'caminho absoluto do `board.mjs` gravado na instalação e `BOARD status` como primeiro passo'],
]);
