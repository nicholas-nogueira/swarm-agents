// Transformação de texto compartilhada pelos adapters (DRY): trocas ancoradas que falham alto se o payload mudou.
import { AdapterError } from './errors.mjs';

/** Caminhos embutidos em texto usam sempre barra normal (Node aceita no Windows e o shell não a come). */
export const toPosix = (p) => String(p).replaceAll('\\', '/');

/** Fim de linha único (LF) antes de qualquer troca ancorada. */
export const normalizeEol = (text) => text.replace(/\r\n?/g, '\n');

const incompat = (what) =>
  new AdapterError(
    `O arquivo da skill não tem o trecho esperado (${what}). O pacote parece ser de outra versão: reinstale o swarm-agents.`,
    'PAYLOAD_INCOMPATIVEL',
  );

/** Troca a primeira ocorrência de `from` por `to` (sem interpretar `$` no texto novo). */
export function replaceOnce(text, from, to, what) {
  if (!text.includes(from)) throw incompat(what);
  return text.replace(from, () => to);
}

/** Troca a linha que casa com `regex` (exige exatamente uma). */
export function replaceLine(text, regex, to, what) {
  const flags = regex.flags.replace('g', '');
  const global = new RegExp(regex.source, `${flags}g`);
  const found = text.match(global) ?? [];
  if (found.length !== 1) throw incompat(what);
  return text.replace(new RegExp(regex.source, flags), () => to);
}

/** Garante que nenhum resquício específico do Claude sobrou no texto gerado. */
export function assertNone(text, patterns, file) {
  for (const re of patterns) {
    if (re.test(text)) {
      throw new AdapterError(
        `Sobrou em ${file} um trecho específico do Claude Code (${re}). O pacote parece ser de outra versão: reinstale o swarm-agents.`,
        'PAYLOAD_INCOMPATIVEL',
      );
    }
  }
}
