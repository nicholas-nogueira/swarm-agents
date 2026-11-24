// Registro dos adapters (contrato com o instalador): ADAPTERS (id -> adapter), listAdapters() e getAdapter(id).
//
// Cada adapter: { id, name, defaultSelected, verified ("native-claude"|"local"|"doc"), notes, detect({home,cwd,env}),
// plan({scope,home,cwd,payload}) => { files: [{path (absoluto), content}], notes } }. O adapter só PLANEJA; quem grava é o instalador.
import { AdapterError } from './lib/errors.mjs';
import { claude } from './claude.mjs';
import { codex } from './codex.mjs';
import { cursor } from './cursor.mjs';
import { opencode } from './opencode.mjs';
import { gemini } from './gemini.mjs';
import { antigravity } from './antigravity.mjs';

export const ADAPTERS = Object.freeze({ claude, codex, cursor, opencode, gemini, antigravity });

/** Adapters na ordem de apresentação. */
export const listAdapters = () => Object.values(ADAPTERS);

/** Busca por id validado (comparação exata contra as chaves próprias: `__proto__` e afins não passam). */
export function getAdapter(id) {
  if (typeof id !== 'string' || !Object.hasOwn(ADAPTERS, id)) {
    throw new AdapterError(
      `Ferramenta desconhecida: ${JSON.stringify(id)}. Use uma de: ${Object.keys(ADAPTERS).join(', ')}.`,
      'FERRAMENTA_DESCONHECIDA',
    );
  }
  return ADAPTERS[id];
}

export { AdapterError };
