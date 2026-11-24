// Pastas de skill/agente que cada ferramenta CARREGA (campo `reads` do plano). O instalador usa isso para avisar quando um
// adapter grava numa pasta que outra ferramenta selecionada também lê (ex.: ~/.agents/skills). O adapter só declara.
import { isAbsolute, join } from 'node:path';

/**
 * @param {{user: string[][], project: string[][]}} reads segmentos relativos a home (user) e a cwd (project)
 * @returns {string[]} caminhos absolutos, únicos e em ordem estável; o escopo project só entra se cwd for absoluto
 */
export function resolveReads(reads, home, cwd) {
  const out = new Set(reads.user.map((segs) => join(home, ...segs)));
  if (typeof cwd === 'string' && isAbsolute(cwd)) for (const segs of reads.project) out.add(join(cwd, ...segs));
  return [...out].sort();
}
