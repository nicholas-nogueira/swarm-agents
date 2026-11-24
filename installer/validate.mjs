// Validação de entrada contra listas fechadas (escopo e ids de ferramenta).
import { InstallerError } from './errors.mjs';

export const SCOPES = Object.freeze(['user', 'project']);
export const DEFAULT_SCOPE = 'user';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Mostra no máximo 40 caracteres do valor digitado, para não ecoar entrada arbitrária. */
function shown(value) {
  const s = String(value);
  return JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}...` : s);
}

export function validateScope(scope) {
  if (scope === undefined) return DEFAULT_SCOPE;
  if (SCOPES.includes(scope)) return scope;
  throw new InstallerError(`Escopo inválido: ${shown(scope)}. Use user ou project.`, { code: 'ESCOPO_INVALIDO' });
}

/**
 * Converte ids pedidos em adapters, na ordem pedida e sem repetição.
 * @param {string[]} ids
 * @param {Array<{id: string}>} adapters
 */
export function resolveClients(ids, adapters) {
  if (!ids || ids.length === 0) {
    throw new InstallerError('Nenhuma ferramenta escolhida.', { code: 'NENHUM_CLIENTE' });
  }
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const out = [];
  for (const id of ids) {
    const adapter = ID_PATTERN.test(id) ? byId.get(id) : undefined;
    if (!adapter) {
      throw new InstallerError(
        `Ferramenta desconhecida: ${shown(id)}. Use uma destas: ${adapters.map((a) => a.id).join(', ')}.`,
        { code: 'CLIENTE_DESCONHECIDO' },
      );
    }
    if (!out.includes(adapter)) out.push(adapter);
  }
  return out;
}
