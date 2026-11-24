// Plano de instalação: pergunta a cada adapter o que gravar e classifica cada destino, sem mexer em nada no disco.
// Operações: create (não existe), update (é nosso e mudou, ou --force), unchanged (bytes iguais), conflict (alheio e diferente).
import { InstallerError, EXIT, describeCause } from './errors.mjs';
import { isAbsolute } from 'node:path';
import { sha256, toBuffer, pathKey, isInside, inspectPath, assertSafeTarget } from './fsutil.mjs';
import { getEntry } from './manifest.mjs';

export const BACKUP_SUFFIX = '.swarm-agents.bak';

function rootFor(scope, home, cwd) {
  return scope === 'project' ? cwd : home;
}

function callAdapter(adapter, args) {
  let result;
  try {
    result = adapter.plan(args);
  } catch (err) {
    throw new InstallerError(`${adapter.name ?? adapter.id}: não foi possível montar o plano (${describeCause(err)}).`, {
      code: 'ADAPTER_FALHOU',
      cause: err,
    });
  }
  const reads = result?.reads ?? [];
  if (!result || !Array.isArray(result.files) || !Array.isArray(reads) || !reads.every((d) => typeof d === 'string' && isAbsolute(d))) {
    throw new InstallerError(`${adapter.name ?? adapter.id}: o adapter devolveu um plano malformado.`, { code: 'PLANO_INVALIDO' });
  }
  return { ...result, reads };
}

/**
 * Avisos de pasta compartilhada: arquivo gravado por A dentro de uma pasta que B (outro selecionado, que não grava
 * esse mesmo arquivo) carrega. Um aviso por (A, B, pasta), com a contagem de arquivos. Não muda destino nenhum.
 */
function sharedReadWarnings(actions, readsById, nameById) {
  const groups = new Map();
  for (const action of actions) {
    for (const [reader, dirs] of readsById) {
      if (action.clients.includes(reader)) continue;
      const dir = dirs.find((d) => isInside(d, action.path));
      if (!dir) continue;
      for (const writer of action.clients) {
        const key = `${writer}\u0000${reader}\u0000${dir}`;
        if (!groups.has(key)) groups.set(key, { writer, reader, dir, count: 0 });
        groups.get(key).count += 1;
      }
    }
  }
  return [...groups.values()].map((g) => ({
    ...g,
    text: `${nameById.get(g.reader)} também lê ${g.dir} e verá os arquivos adaptados para ${nameById.get(g.writer)} (${g.count} arquivo(s) de ${g.writer} nessa pasta).`,
  }));
}

/** Escolhe onde guardar o backup sem nunca sobrescrever um backup anterior diferente. */
async function chooseBackup(path, currentBytes) {
  const primary = `${path}${BACKUP_SUFFIX}`;
  const info = await inspectPath(primary);
  if (!info.exists) return { backupPath: primary, backupExists: false };
  if (info.kind === 'file' && info.bytes.equals(currentBytes)) return { backupPath: primary, backupExists: true };
  const alt = `${primary}.${sha256(currentBytes).slice(0, 12)}`;
  const altInfo = await inspectPath(alt);
  return { backupPath: alt, backupExists: altInfo.kind === 'file' && altInfo.bytes.equals(currentBytes) };
}

async function classify(item, { manifest, force }) {
  const info = await inspectPath(item.path);
  const base = { ...item, currentSha: null, backupPath: null, backupExists: false, reason: null };
  if (!info.exists) return { ...base, op: 'create' };
  if (info.kind !== 'file') return { ...base, op: 'conflict', reason: 'nao-e-arquivo' };
  const currentSha = sha256(info.bytes);
  if (info.bytes.equals(item.content)) return { ...base, op: 'unchanged', currentSha };
  const entry = getEntry(manifest, item.path);
  const ours = entry !== null && entry.sha256 === currentSha;
  if (!ours && !force) return { ...base, op: 'conflict', currentSha, reason: 'alheio' };
  const backup = await chooseBackup(item.path, info.bytes);
  return { ...base, op: 'update', currentSha, reason: ours ? 'nosso' : 'force', ...backup };
}

/** Erro de conflito (código de saída 2) com a lista de destinos e o que fazer. */
export function conflictError(plan) {
  const conflicts = plan.actions.filter((a) => a.op === 'conflict');
  const lines = conflicts.map((a) =>
    a.reason === 'nao-e-arquivo'
      ? `  - ${a.path} (é uma pasta ou link: remova ou renomeie; --force não resolve)`
      : `  - ${a.path} (existe, não foi instalado pelo swarm-agents e é diferente)`,
  );
  return new InstallerError(
    [
      `Conflito em ${conflicts.length} arquivo(s); nada foi gravado:`,
      ...lines,
      'Para sobrescrever guardando backup (.swarm-agents.bak), rode de novo com --force.',
    ].join('\n'),
    { code: 'CONFLITO', exitCode: EXIT.CONFLICT },
  );
}

/**
 * @param {{ adapters: object[], scope: 'user'|'project', home: string, cwd: string,
 *           payload: Map<string, Buffer>, manifest: object, force?: boolean }} args
 */
export async function buildPlan({ adapters, scope, home, cwd, payload, manifest, force = false }) {
  const root = rootFor(scope, home, cwd);
  const byKey = new Map();
  const notes = [];
  const readsById = new Map();
  for (const adapter of adapters) {
    const result = callAdapter(adapter, { scope, home, cwd, payload });
    if (result.reads.length) readsById.set(adapter.id, result.reads);
    for (const text of result.notes ?? []) notes.push({ client: adapter.id, text });
    for (const file of result.files) {
      await assertSafeTarget(root, file?.path);
      const content = toBuffer(file.content);
      const key = pathKey(file.path);
      const prev = byKey.get(key);
      if (prev) {
        if (!prev.content.equals(content)) {
          throw new InstallerError(
            `${prev.clients.join(', ')} e ${adapter.id} querem gravar conteúdos diferentes no mesmo arquivo: ${file.path}. Instale-os separadamente.`,
            { code: 'DESTINO_DUPLICADO' },
          );
        }
        if (!prev.clients.includes(adapter.id)) prev.clients.push(adapter.id);
        continue;
      }
      byKey.set(key, { key, path: file.path, clients: [adapter.id], content, sha256: sha256(content) });
    }
  }
  const actions = [];
  for (const item of byKey.values()) actions.push(await classify(item, { manifest, force }));
  const counts = { create: 0, update: 0, unchanged: 0, conflict: 0 };
  for (const a of actions) counts[a.op] += 1;
  const nameById = new Map(adapters.map((a) => [a.id, a.name ?? a.id]));
  const warnings = sharedReadWarnings(actions, readsById, nameById);
  return { scope, root, home, cwd, clients: adapters.map((a) => a.id), actions, notes, warnings, counts };
}
