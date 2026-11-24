// Carrega o payload (arquivos de runtime da skill e dos agentes) como Map relPath -> Buffer.
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InstallerError } from './errors.mjs';

/**
 * @param {string} dir pasta payload/ do repositório
 * @returns {Promise<Map<string, Buffer>>} chave com barra normal (ex.: skills/swarm/SKILL.md)
 */
export async function loadPayload(dir) {
  let st;
  try {
    st = await lstat(dir);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) {
    throw new InstallerError(`Payload não encontrado em ${dir}. Reinstale o pacote swarm-agents.`, { code: 'PAYLOAD_AUSENTE' });
  }
  const payload = new Map();
  const walk = async (abs, rel) => {
    const entries = await readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const childAbs = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        throw new InstallerError(`O payload contém um link simbólico (${childRel}); por segurança nada será instalado.`, { code: 'PAYLOAD_LINK' });
      }
      if (e.isDirectory()) await walk(childAbs, childRel);
      else if (e.isFile()) payload.set(childRel, await readFile(childAbs));
    }
  };
  await walk(dir, '');
  if (payload.size === 0) {
    throw new InstallerError(`O payload em ${dir} está vazio. Reinstale o pacote swarm-agents.`, { code: 'PAYLOAD_VAZIO' });
  }
  return payload;
}
