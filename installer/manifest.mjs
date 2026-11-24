// Manifesto de propriedade: registra cada arquivo que o swarm-agents gravou (caminho, ferramentas, escopo, raiz, sha256)
// e os diretórios que ele criou. O uninstall só remove o que está aqui e cujo conteúdo ainda bate.
import { readFile } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { InstallerError, describeCause } from './errors.mjs';
import { atomicWrite, pathKey } from './fsutil.mjs';
import { SCOPES } from './validate.mjs';

const TOOL = 'swarm-agents';
const VERSION = 1;

export function manifestFile({ home, env }) {
  const override = env?.SWARM_AGENTS_HOME;
  const dir = override ? resolve(override) : join(home, '.swarm-agents');
  return join(dir, 'manifest.json');
}

export function emptyManifest() {
  return { tool: TOOL, version: VERSION, entries: {}, dirs: [] };
}

function isValidEntry(e) {
  return (
    e &&
    typeof e === 'object' &&
    typeof e.path === 'string' &&
    isAbsolute(e.path) &&
    Array.isArray(e.clients) &&
    e.clients.every((c) => typeof c === 'string') &&
    SCOPES.includes(e.scope) &&
    typeof e.root === 'string' &&
    isAbsolute(e.root) &&
    typeof e.sha256 === 'string'
  );
}

function invalid(file, detail) {
  return new InstallerError(
    `O manifesto ${file} está corrompido (${detail}). Ele não foi alterado; renomeie-o ou apague-o e rode a instalação de novo.`,
    { code: 'MANIFESTO_INVALIDO' },
  );
}

export async function loadManifest(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyManifest();
    throw new InstallerError(`Não foi possível ler o manifesto ${file} (${describeCause(err)}).`, { code: 'MANIFESTO_INVALIDO' });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid(file, 'JSON inválido');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.tool !== TOOL) throw invalid(file, 'não é um manifesto do swarm-agents');
  if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw invalid(file, 'entries');
  if (!Array.isArray(data.dirs) || !data.dirs.every((d) => typeof d === 'string' && isAbsolute(d))) throw invalid(file, 'dirs');
  for (const e of Object.values(data.entries)) if (!isValidEntry(e)) throw invalid(file, 'entrada malformada');
  return { tool: TOOL, version: VERSION, entries: data.entries, dirs: data.dirs };
}

export async function saveManifest(file, manifest) {
  const text = `${JSON.stringify({ ...manifest, tool: TOOL, version: VERSION }, null, 2)}\n`;
  await atomicWrite(file, Buffer.from(text, 'utf8'));
}

export function getEntry(manifest, path) {
  return manifest.entries[pathKey(path)] ?? null;
}

export function setEntry(manifest, entry) {
  manifest.entries[pathKey(entry.path)] = { ...entry, clients: [...new Set(entry.clients)].sort() };
}

export function deleteEntry(manifest, path) {
  delete manifest.entries[pathKey(path)];
}

export function listEntries(manifest) {
  return Object.values(manifest.entries);
}
