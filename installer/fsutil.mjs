// Operações de arquivo seguras: hash, contenção na raiz, recusa de link, escrita atômica e limpeza de diretórios.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile, rename, mkdir, rm, rmdir, realpath } from 'node:fs/promises';
import { dirname, basename, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { InstallerError } from './errors.mjs';

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  throw new InstallerError('Conteúdo de arquivo inválido no plano (esperado texto ou Buffer).', { code: 'CONTEUDO_INVALIDO' });
}

/** Chave de comparação de caminhos (o sistema de arquivos do Windows não diferencia maiúsculas). */
export function pathKey(p) {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Verdadeiro só se `p` estiver estritamente dentro de `root`. */
export function isInside(root, p) {
  const rel = relative(resolve(root), resolve(p));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Estado de um caminho sem seguir link: { exists, kind: 'file'|'dir'|'symlink'|'other'|null, bytes }. */
export async function inspectPath(p, io = {}) {
  let st;
  try {
    st = await lstat(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { exists: false, kind: null, bytes: null };
    throw err;
  }
  if (st.isSymbolicLink()) return { exists: true, kind: 'symlink', bytes: null };
  if (st.isDirectory()) return { exists: true, kind: 'dir', bytes: null };
  if (!st.isFile()) return { exists: true, kind: 'other', bytes: null };
  const bytes = await (io.readFile ?? readFile)(p);
  return { exists: true, kind: 'file', bytes };
}

/** Diretórios ancestrais de `file` que ainda não existem, do mais raso ao mais fundo. */
export async function missingAncestors(file) {
  const missing = [];
  let dir = dirname(resolve(file));
  for (;;) {
    const info = await inspectPath(dir);
    if (info.exists) break;
    missing.unshift(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return missing;
}

/**
 * Garante que `target` é absoluto, fica dentro de `root` e não passa por link que leve para fora de `root`.
 * Também recusa quando o próprio destino é um link.
 */
export async function assertSafeTarget(root, target) {
  if (typeof target !== 'string' || !isAbsolute(target)) {
    throw new InstallerError('O plano tem um destino que não é caminho absoluto; nada foi gravado.', { code: 'DESTINO_INVALIDO' });
  }
  if (!isInside(root, target)) {
    throw new InstallerError(`Destino fora da pasta permitida (${root}): ${target}. Nada foi gravado.`, { code: 'DESTINO_FORA_DA_RAIZ' });
  }
  const self = await inspectPath(target);
  if (self.kind === 'symlink') {
    throw new InstallerError(`O destino é um link simbólico e não será seguido: ${target}.`, { code: 'DESTINO_LINK' });
  }
  // O ancestral existente mais próximo, resolvido, precisa continuar dentro da raiz resolvida.
  let probe = dirname(resolve(target));
  while (!(await inspectPath(probe)).exists && dirname(probe) !== probe) probe = dirname(probe);
  const realRoot = await realpath(root);
  const realProbe = await realpath(probe);
  if (pathKey(realProbe) !== pathKey(realRoot) && !isInside(realRoot, realProbe)) {
    throw new InstallerError(`O caminho passa por um link que leva para fora de ${root}: ${target}.`, { code: 'DESTINO_LINK' });
  }
}

/**
 * Escrita atômica: grava num temporário na mesma pasta e renomeia por cima.
 * @returns {Promise<string[]>} diretórios criados para caber o arquivo
 */
export async function atomicWrite(file, buf) {
  const created = await missingAncestors(file);
  if (created.length) await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.swarm-agents.tmp`);
  try {
    await writeFile(tmp, buf, { flag: 'wx' });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return created;
}

/** Remove os diretórios da lista que estiverem vazios, do mais fundo ao mais raso. Devolve os removidos. */
export async function removeEmptyDirs(dirs) {
  const removed = [];
  const ordered = [...new Set(dirs.map((d) => resolve(d)))].sort((a, b) => b.length - a.length);
  for (const dir of ordered) {
    const info = await inspectPath(dir);
    if (info.kind !== 'dir') continue;
    try {
      await rmdir(dir);
      removed.push(dir);
    } catch {
      // não está vazio (ou está em uso): fica onde está
    }
  }
  return removed;
}
