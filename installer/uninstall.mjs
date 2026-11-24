// Desinstalação: só remove o que o manifesto registra, que ainda está dentro da raiz registrada,
// é arquivo comum (não link) e cujo conteúdo ainda bate com o sha256 gravado.
import { unlink } from 'node:fs/promises';
import { InstallerError, describeCause } from './errors.mjs';
import { sha256, isInside, inspectPath, assertSafeTarget, removeEmptyDirs } from './fsutil.mjs';
import { listEntries, setEntry, deleteEntry, saveManifest } from './manifest.mjs';

async function classify(entry, mine) {
  const remaining = entry.clients.filter((c) => !mine.includes(c));
  const base = { path: entry.path, entry, remaining, clients: mine };
  if (!isInside(entry.root, entry.path)) return { ...base, op: 'skip-unsafe' };
  const info = await inspectPath(entry.path);
  if (!info.exists) return { ...base, op: 'missing' };
  if (info.kind !== 'file') return { ...base, op: 'skip-unsafe' };
  try {
    await assertSafeTarget(entry.root, entry.path);
  } catch {
    return { ...base, op: 'skip-unsafe' };
  }
  if (remaining.length > 0) return { ...base, op: 'detach' };
  if (sha256(info.bytes) !== entry.sha256) return { ...base, op: 'keep-modified' };
  return { ...base, op: 'remove' };
}

/**
 * @param {{ manifest: object, clients?: string[]|null, scope?: 'user'|'project'|null }} args
 */
export async function planUninstall({ manifest, clients = null, scope = null }) {
  const actions = [];
  for (const entry of listEntries(manifest)) {
    if (scope && entry.scope !== scope) continue;
    const mine = clients ? entry.clients.filter((c) => clients.includes(c)) : [...entry.clients];
    if (mine.length === 0) continue;
    actions.push(await classify(entry, mine));
  }
  return actions;
}

/**
 * @returns {Promise<{ removed: string[], kept: string[], detached: string[], missing: string[], skipped: string[], removedDirs: string[] }>}
 */
export async function applyUninstall(actions, { manifest, manifestFile, io = {} }) {
  const next = structuredClone(manifest);
  const out = { removed: [], kept: [], detached: [], missing: [], skipped: [], removedDirs: [] };
  if (actions.length === 0) return out;
  try {
    for (const a of actions) {
      if (a.op === 'remove') {
        await (io.unlink ?? unlink)(a.path);
        deleteEntry(next, a.path);
        out.removed.push(a.path);
      } else if (a.op === 'detach') {
        setEntry(next, { ...a.entry, clients: a.remaining });
        out.detached.push(a.path);
      } else if (a.op === 'keep-modified') {
        deleteEntry(next, a.path);
        out.kept.push(a.path);
      } else if (a.op === 'missing') {
        deleteEntry(next, a.path);
        out.missing.push(a.path);
      } else {
        out.skipped.push(a.path);
      }
    }
  } catch (err) {
    await saveManifest(manifestFile, next);
    throw new InstallerError(
      `Não foi possível remover um arquivo (${describeCause(err)}). ${out.removed.length} arquivo(s) já removido(s); o manifesto foi atualizado. Feche programas que usem esses arquivos e rode de novo.`,
      { code: 'FALHA_NA_REMOCAO', cause: err },
    );
  }
  out.removedDirs = await removeEmptyDirs(next.dirs);
  const gone = new Set(out.removedDirs);
  const left = [];
  for (const d of next.dirs) if (!gone.has(d) && (await inspectPath(d)).kind === 'dir') left.push(d);
  next.dirs = left;
  await saveManifest(manifestFile, next);
  return out;
}
