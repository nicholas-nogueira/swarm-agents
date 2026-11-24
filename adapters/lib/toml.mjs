// Escrita mínima de strings TOML (o Codex usa um arquivo .toml por agente). Sem dependências.

const hex4 = (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
const CONTROLES = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** String básica de uma linha ("...") com escapes TOML. */
export function tomlString(value) {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replace(CONTROLES, hex4)}"`;
}

/** String básica multilinha ("""..."""): legível no arquivo, com barra, aspas triplas e controles escapados. */
export function tomlMultiline(value) {
  let body = String(value)
    .replace(/\r\n?/g, '\n')
    .replaceAll('\\', '\\\\')
    .replaceAll('"""', '""\\"')
    .replace(CONTROLES, hex4);
  if (body.endsWith('"')) body = `${body.slice(0, -1)}\\"`;
  return `"""\n${body}"""`;
}
