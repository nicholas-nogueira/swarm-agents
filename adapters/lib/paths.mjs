// Validação de escopo e caminhos (OWASP A01/A05: nada de caminho vindo de fora sem validar) e checagens de existência.
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AdapterError } from './errors.mjs';

export const SCOPES = Object.freeze(['user', 'project']);

/** Aceita só "user" ou "project" (comparação exata, sem normalizar). */
export function assertScope(scope) {
  if (!SCOPES.includes(scope)) {
    throw new AdapterError(`Escopo inválido: ${JSON.stringify(scope)}. Use "user" ou "project".`, 'ESCOPO_INVALIDO');
  }
  return scope;
}

/** O caminho precisa ser uma string absoluta, sem byte nulo. */
export function assertAbsolute(label, value) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) {
    throw new AdapterError(`O caminho "${label}" precisa ser absoluto (recebi ${JSON.stringify(value)}).`, 'CAMINHO_INVALIDO');
  }
  return value;
}

function stat(p) {
  if (typeof p !== 'string' || p === '') return null;
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export const dirExists = (p) => stat(p)?.isDirectory() ?? false;
export const fileExists = (p) => stat(p)?.isFile() ?? false;
