// Frontmatter YAML mínimo, sem dependências: lê pares `chave: valor` e escreve YAML válido (com aspas quando preciso).
import { AdapterError } from './errors.mjs';
import { normalizeEol } from './text.mjs';

const invalido = (msg) => new AdapterError(msg, 'FRONTMATTER_INVALIDO');

function unquote(raw) {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  return v;
}

/** Separa o frontmatter (só pares simples chave: valor) do corpo. */
export function parseFrontmatter(text) {
  const t = normalizeEol(text).replace(/^﻿/, '');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) throw new AdapterError('O arquivo não começa com um bloco de frontmatter (---).', 'FRONTMATTER_AUSENTE');
  const data = {};
  for (const line of m[1].split('\n')) {
    if (line.trim() === '') continue;
    const kv = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!kv) throw invalido(`Linha de frontmatter não suportada: "${line}".`);
    data[kv[1]] = unquote(kv[2] ?? '');
  }
  return { data, body: t.slice(m[0].length) };
}

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const AMBIGUO = /^(?:true|false|null|yes|no|on|off|~|[-+]?[0-9][0-9._]*)$/i;

function scalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v !== 'string') throw invalido(`Valor de frontmatter não suportado: ${typeof v}.`);
  return PLAIN.test(v) && !AMBIGUO.test(v) ? v : JSON.stringify(v);
}

/** Escreve o bloco `---` ... `---` com uma linha final em branco omitida (o chamador decide o espaçamento). */
export function buildFrontmatter(data) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value)) {
      lines.push(`${key}: ${scalar(value)}`);
    } else if (value.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))) {
      lines.push(`${key}:`);
      for (const item of value) {
        Object.entries(item).forEach(([k, v], i) => lines.push(`${i === 0 ? '  - ' : '    '}${k}: ${scalar(v)}`));
      }
    } else {
      lines.push(`${key}: [${value.map(scalar).join(', ')}]`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}
