// O npm nunca publica arquivos .gitignore. O payload do Claude precisa do payload/skills/swarm/.gitignore
// (byte a byte), então no pacote ele viaja como "dot-gitignore" e o loadPayload o devolve como ".gitignore".
// Uso (npm scripts): node scripts/pack-gitignore.mjs prepack|postpack
import { copyFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ_PAYLOAD = fileURLToPath(new URL('../payload', import.meta.url));
const REL_SKILL = 'skills/swarm';

/** Cria a cópia dot-gitignore ao lado do .gitignore. Falha com mensagem clara se o original não existe. */
export async function prepararPacote(dir = RAIZ_PAYLOAD, rel = REL_SKILL) {
  const origem = join(dir, rel, '.gitignore');
  try {
    await access(origem);
  } catch {
    throw new Error(`Não achei ${origem}: sem ele o pacote npm ficaria diferente do payload do Claude.`);
  }
  await copyFile(origem, join(dir, rel, 'dot-gitignore'));
  return true;
}

/** Remove só a cópia dot-gitignore (nunca o .gitignore). Idempotente. */
export async function limparPacote(dir = RAIZ_PAYLOAD, rel = REL_SKILL) {
  const copia = join(dir, rel, 'dot-gitignore');
  try {
    await access(copia);
  } catch {
    return false;
  }
  await rm(copia);
  return true;
}

/* node:coverage ignore next 8 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const acao = process.argv[2];
  try {
    if (acao === 'prepack') await prepararPacote();
    else if (acao === 'postpack') await limparPacote();
    else throw new Error('Use: node scripts/pack-gitignore.mjs prepack|postpack');
  } catch (e) {
    console.error(`swarm-agents: ${e.message}`);
    process.exit(1);
  }
}
