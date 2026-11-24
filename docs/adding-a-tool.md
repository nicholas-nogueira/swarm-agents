# Como adicionar uma ferramenta nova

O instalador é genérico: só grava o que o adapter planejou. Adicionar uma ferramenta é escrever um adapter.

## 1. Levante os fatos antes de codar

Use só documentação oficial ou arquivos locais lidos. O que não estiver confirmado vira "não verificado" (no código e na doc), nunca suposição. Colete:

- onde a skill vive (escopo `user` e `project`) e o formato do `SKILL.md`;
- onde vivem os subagentes e o formato (md com frontmatter, toml etc.);
- se há slash command por skill, injeção de comando, variável de diretório, `SendMessage`, `TaskStop`, subagente em background, subagente dentro de subagente;
- como bloquear edição de arquivos no agente verifier;
- como rodar `node` (qual shell).

## 2. Contrato do adapter (`adapters/<id>.mjs`)

```js
export default {
  id: 'minha-ferramenta',          // [a-z0-9-], validado pelo instalador
  name: 'Minha Ferramenta',
  defaultSelected: true,           // false se colidir com recurso nativo
  verified: 'doc',                 // 'native-claude' | 'local' | 'doc'
  notes: ['o que não foi verificado'],
  detect({ home, cwd, env }) { /* boolean; só olha o sistema de arquivos, nunca config */ },
  plan({ scope, home, cwd, payload }) {
    // payload: Map relPath -> Buffer (payload/)
    return { files: [{ path: '/absoluto', content: '...' }], notes: [] };
  },
};
```

Regras:

- Todos os `path` são absolutos e ficam dentro de `home` (escopo `user`) ou `cwd` (escopo `project`).
- Nunca leia nem edite arquivo de configuração da ferramenta.
- Para ferramentas que não são o Claude, o `SKILL.md` e os agentes são renderizados a partir do mesmo payload. Troque o que é específico do Claude (injeção por exclamação e comando, `CLAUDE_SKILL_DIR`, `CLAUDE_SESSION_ID`) conforme `docs/limitations.md`, e acrescente a seção inicial "Adaptação para <ferramenta>".
- Reuse os módulos comuns (transformação de texto e frontmatter) em vez de copiar lógica.

## 3. Registre

Exporte o adapter em `adapters/index.mjs` (`ADAPTERS` e `listAdapters()`).

## 4. Testes (TDD, antes do código)

Em `tests/adapters/`: caminhos por escopo, conteúdo gerado, frontmatter válido, ausência de `CLAUDE_SKILL_DIR` e `CLAUDE_SESSION_ID`, caminho absoluto do `board.mjs`, e cenários negativos (payload incompleto, escopo inválido). Cobertura mínima de 90%.

## 5. Documente

Acrescente a ferramenta na tabela do `README.md` e as lacunas em `docs/limitations.md`.
