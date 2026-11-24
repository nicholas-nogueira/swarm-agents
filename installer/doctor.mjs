// Diagnóstico: versão do Node, payload, manifesto e, por ferramenta instalada, se os arquivos estão íntegros e atuais.
import { buildPlan } from './plan.mjs';
import { sha256, inspectPath } from './fsutil.mjs';
import { listEntries } from './manifest.mjs';

const MIN_NODE = 24;

function nodeCheck(version) {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  return major >= MIN_NODE
    ? { level: 'ok', text: `Node ${version} (mínimo ${MIN_NODE})` }
    : { level: 'erro', text: `Node ${version} é antigo: o swarm-agents precisa do Node ${MIN_NODE} ou mais novo.` };
}

function groupEntries(manifest) {
  const groups = new Map();
  for (const e of listEntries(manifest)) {
    for (const client of e.clients) {
      const key = `${client}\u0000${e.scope}\u0000${e.root}`;
      if (!groups.has(key)) groups.set(key, { client, scope: e.scope, root: e.root, entries: [] });
      groups.get(key).entries.push(e);
    }
  }
  return [...groups.values()];
}

async function fileProblem(entry) {
  const info = await inspectPath(entry.path);
  if (!info.exists) return 'ausente';
  if (info.kind !== 'file') return 'não é arquivo comum';
  return sha256(info.bytes) === entry.sha256 ? null : 'modificado';
}

async function checkGroup(group, { adapter, manifest, payload, home }) {
  const label = `${group.client} (${group.scope}, ${group.root})`;
  const fix = `swarm-agents install --client ${group.client} --scope ${group.scope}`;
  if (!adapter) {
    return { level: 'aviso', text: `${label}: ferramenta registrada no manifesto não existe nesta versão (${group.entries.length} arquivo(s)).` };
  }
  const problems = [];
  for (const e of group.entries) {
    const p = await fileProblem(e);
    if (p) problems.push(`${e.path} (${p})`);
  }
  if (problems.length) {
    return { level: 'erro', text: `${label}: ${problems.length} arquivo(s) com problema: ${problems.join('; ')}. Para restaurar rode: ${fix} (arquivo modificado exige --force).` };
  }
  try {
    const plan = await buildPlan({
      adapters: [adapter],
      scope: group.scope,
      home: group.scope === 'user' ? group.root : home,
      cwd: group.root,
      payload,
      manifest,
    });
    const outdated = plan.actions.filter((a) => a.op !== 'unchanged').length;
    if (outdated) return { level: 'aviso', text: `${label}: ${outdated} arquivo(s) desatualizado(s) em relação a esta versão; rode: ${fix}` };
    return { level: 'ok', text: `${label}: ${group.entries.length} arquivo(s), atual.` };
  } catch (err) {
    return { level: 'erro', text: `${label}: ${err.message}` };
  }
}

/**
 * @returns {Promise<{ ok: boolean, checks: Array<{ level: 'ok'|'aviso'|'erro', text: string }> }>}
 */
export async function runDoctor({ adapters, manifest, manifestFile, payload, home, nodeVersion = process.version }) {
  const checks = [nodeCheck(nodeVersion), { level: 'ok', text: `Payload: ${payload.size} arquivo(s)` }, { level: 'ok', text: `Manifesto: ${manifestFile}` }];
  const groups = groupEntries(manifest);
  if (groups.length === 0) checks.push({ level: 'aviso', text: 'Nada instalado ainda. Rode: swarm-agents install' });
  const byId = new Map(adapters.map((a) => [a.id, a]));
  for (const g of groups) checks.push(await checkGroup(g, { adapter: byId.get(g.client), manifest, payload, home }));
  return { ok: !checks.some((c) => c.level === 'erro'), checks };
}
