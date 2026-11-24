// Acesso ao payload (Map relPath -> Buffer, carregado por installer/payload.mjs).
import { AdapterError } from './errors.mjs';

export const SKILL_PREFIX = 'skills/swarm/';
export const WORKER_FILE = 'agents/swarm-worker.md';
export const VERIFIER_FILE = 'agents/swarm-verifier.md';
export const REQUIRED = Object.freeze([`${SKILL_PREFIX}SKILL.md`, `${SKILL_PREFIX}scripts/board.mjs`, WORKER_FILE, VERIFIER_FILE]);

const incompleto = (msg) => new AdapterError(msg, 'PAYLOAD_INCOMPLETO');

/**
 * Chave do payload segura para virar caminho (OWASP A01, defesa em profundidade): relativa, com barra normal,
 * sem segmento vazio, "." ou "..", sem letra de unidade e sem byte nulo.
 */
export function assertSafeKey(rel) {
  const ruim =
    typeof rel !== 'string' ||
    rel === '' ||
    rel.includes('\u0000') ||
    rel.includes('\\') ||
    rel.startsWith('/') ||
    /^[A-Za-z]:/.test(rel) ||
    rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
  if (ruim) {
    throw new AdapterError(
      `O pacote do swarm tem um arquivo com caminho inseguro (${JSON.stringify(rel)}): ele sairia da pasta de instalação. Nada foi gravado; reinstale o swarm-agents.`,
      'PAYLOAD_INCOMPATIVEL',
    );
  }
}

/** O payload precisa ser um Map com os arquivos indispensáveis; diz exatamente o que falta. */
export function assertPayload(payload) {
  if (!(payload instanceof Map)) throw incompleto('O pacote do swarm não foi carregado (payload inválido).');
  for (const rel of payload.keys()) assertSafeKey(rel);
  const faltam = REQUIRED.filter((rel) => !payload.has(rel));
  if (faltam.length) {
    throw incompleto(`O pacote do swarm está incompleto: faltam ${faltam.join(', ')}. Reinstale o swarm-agents.`);
  }
}

/** Conteúdo UTF-8 de um arquivo do payload. */
export function textOf(payload, rel) {
  const buf = payload.get(rel);
  if (buf === undefined) throw incompleto(`O pacote do swarm está incompleto: falta ${rel}. Reinstale o swarm-agents.`);
  return Buffer.from(buf).toString('utf8');
}

/** Arquivos de skills/swarm/** em ordem estável: { rel (relativo à skill), content (Buffer) }. */
export function skillEntries(payload) {
  return [...payload.keys()]
    .filter((rel) => rel.startsWith(SKILL_PREFIX))
    .sort()
    .map((rel) => ({ rel: rel.slice(SKILL_PREFIX.length), content: Buffer.from(payload.get(rel)) }));
}
