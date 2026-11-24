// Aplicação transacional do plano: confere o alvo de novo, faz backup, grava de forma atômica, relê e,
// em qualquer falha, desfaz tudo o que já tinha feito (rollback) antes de reportar.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { InstallerError, describeCause } from './errors.mjs';
import { sha256, inspectPath, atomicWrite, missingAncestors, removeEmptyDirs } from './fsutil.mjs';
import { getEntry, setEntry, saveManifest } from './manifest.mjs';
import { conflictError } from './plan.mjs';

async function rollback(journal) {
  const failed = [];
  for (const step of [...journal].reverse()) {
    try {
      if (step.prev === null) await rm(step.path, { force: true });
      else await atomicWrite(step.path, step.prev);
    } catch {
      failed.push(step.path);
    }
    if (step.backupCreated) await rm(step.backupCreated, { force: true }).catch(() => failed.push(step.backupCreated));
    await removeEmptyDirs(step.createdDirs);
  }
  return failed;
}

async function writeStep(action, journal, io) {
  const current = await inspectPath(action.path);
  const currentSha = current.kind === 'file' ? sha256(current.bytes) : null;
  if ((current.exists && current.kind !== 'file') || currentSha !== action.currentSha) {
    throw new InstallerError(`O arquivo mudou enquanto a instalação rodava: ${action.path}. Rode o comando de novo.`, { code: 'ALVO_MUDOU' });
  }
  const step = { path: action.path, prev: current.exists ? current.bytes : null, createdDirs: await missingAncestors(action.path), backupCreated: null };
  journal.push(step);
  if (action.op === 'update' && !action.backupExists) {
    await writeFile(action.backupPath, current.bytes, { flag: 'wx' });
    step.backupCreated = action.backupPath;
  }
  if (io.beforeWrite) await io.beforeWrite(action.path);
  await atomicWrite(action.path, action.content);
  const back = await (io.readFile ?? readFile)(action.path);
  if (!back.equals(action.content)) {
    throw new InstallerError(`A conferência depois da escrita falhou em ${action.path}.`, { code: 'READBACK' });
  }
  return step;
}

/**
 * @param {object} plan resultado de buildPlan
 * @param {{ manifest: object, manifestFile: string, io?: { readFile?: Function, beforeWrite?: Function }, now?: () => string }} opts
 * @returns {Promise<{ results: object[], backups: string[], manifest: object }>}
 */
export async function applyPlan(plan, { manifest, manifestFile, io = {}, now = () => new Date().toISOString() }) {
  if (plan.counts.conflict > 0) throw conflictError(plan);
  const next = structuredClone(manifest);
  const journal = [];
  const results = [];
  const backups = [];
  try {
    for (const action of plan.actions) {
      if (action.op !== 'unchanged') {
        await writeStep(action, journal, io);
        if (action.op === 'update') backups.push(action.backupPath);
      }
      const status = { create: 'created', update: 'updated', unchanged: 'unchanged' }[action.op];
      results.push({ path: action.path, clients: action.clients, op: action.op, status, backupPath: action.backupPath });
      const prev = getEntry(next, action.path);
      const clients = [...new Set([...(prev?.clients ?? []), ...action.clients])].sort();
      const same =
        prev && prev.sha256 === action.sha256 && prev.scope === plan.scope && prev.root === plan.root && prev.clients.join() === clients.join();
      if (!same) {
        setEntry(next, { path: action.path, clients, scope: plan.scope, root: plan.root, sha256: action.sha256, updatedAt: now() });
      }
    }
    const dirs = new Set(next.dirs);
    for (const step of journal) for (const d of step.createdDirs) dirs.add(d);
    next.dirs = [...dirs].sort();
    // Idempotência: se nada mudou, nem o manifesto é regravado.
    if (JSON.stringify(next) !== JSON.stringify(manifest)) await saveManifest(manifestFile, next);
  } catch (err) {
    const failed = await rollback(journal);
    if (err instanceof InstallerError && err.code === 'ALVO_MUDOU' && failed.length === 0) throw err;
    const undo = failed.length
      ? ` ATENÇÃO: não foi possível desfazer ${failed.length} arquivo(s): ${failed.join(', ')}.`
      : ' As mudanças foram desfeitas; nada ficou pela metade.';
    const reason = err instanceof InstallerError ? err.message : describeCause(err);
    throw new InstallerError(`A instalação falhou: ${reason}${undo}`, { code: err?.code === 'ALVO_MUDOU' ? 'ALVO_MUDOU' : 'FALHA_NA_ESCRITA', cause: err });
  }
  return { results, backups, manifest: next };
}
