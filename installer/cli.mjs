// CLI do swarm-agents: install | uninstall | doctor | list | help.
// main(argv, ctx) não depende de process.*: o contexto (home, cwd, env, streams, adapters, payload) é injetado.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { InstallerError, EXIT } from './errors.mjs';
import { validateScope, resolveClients, SCOPES, DEFAULT_SCOPE } from './validate.mjs';
import { loadPayload } from './payload.mjs';
import { manifestFile, loadManifest } from './manifest.mjs';
import { buildPlan, conflictError } from './plan.mjs';
import { applyPlan } from './apply.mjs';
import { planUninstall, applyUninstall } from './uninstall.mjs';
import { runDoctor } from './doctor.mjs';
import { createPrompter } from './prompt.mjs';

const COMMON = { help: { type: 'boolean', short: 'h' } };
const OPTIONS = {
  install: {
    ...COMMON,
    client: { type: 'string', short: 'c', multiple: true },
    'all-detected': { type: 'boolean' },
    scope: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
  },
  uninstall: {
    ...COMMON,
    client: { type: 'string', short: 'c', multiple: true },
    scope: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    'dry-run': { type: 'boolean' },
  },
  doctor: COMMON,
  list: COMMON,
  help: COMMON,
};

const OP_LABEL = { create: 'criar', update: 'atualizar', unchanged: 'sem mudança', conflict: 'CONFLITO' };
const UNINSTALL_LABEL = {
  remove: 'remover',
  detach: 'desvincular',
  'keep-modified': 'manter (modificado por você)',
  missing: 'já ausente',
  'skip-unsafe': 'ignorar (inseguro)',
};

/** Aceita o módulo adapters/index.mjs com listAdapters() (objetos ou ids) ou só ADAPTERS. */
export function loadAdapters(mod) {
  const byId = mod.ADAPTERS ?? {};
  const list = typeof mod.listAdapters === 'function' ? mod.listAdapters() : Object.values(byId);
  const adapters = list.map((a) => (typeof a === 'string' ? byId[a] : a)).filter(Boolean);
  if (adapters.length === 0) {
    throw new InstallerError('Nenhum adapter de ferramenta encontrado (adapters/index.mjs). Reinstale o pacote swarm-agents.', { code: 'ADAPTERS_AUSENTES' });
  }
  return adapters;
}

// Contexto real do processo: exercitado só pelos testes e2e (processo filho), fora da cobertura em processo.
/* node:coverage disable */
export function createDefaultContext() {
  return {
    payloadDir: fileURLToPath(new URL('../payload', import.meta.url)),
    home: homedir(),
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    nodeVersion: process.version,
  };
}
/* node:coverage enable */

function helpText(adapters) {
  return [
    'swarm-agents: instala a skill /swarm e os agentes swarm-worker e swarm-verifier nas ferramentas agênticas.',
    '',
    'Uso:',
    '  swarm-agents install [--client <id> ...] [--all-detected] [--scope user|project] [--yes] [--dry-run] [--force]',
    '  swarm-agents uninstall [--client <id> ...] [--scope user|project] [--yes] [--dry-run]',
    '  swarm-agents doctor',
    '  swarm-agents list',
    '',
    'Sem argumentos, num terminal: escolha interativa das ferramentas e do escopo.',
    `Ferramentas: ${adapters.map((a) => a.id).join(', ')}.`,
    `Escopo: ${SCOPES.join(' ou ')} (padrão ${DEFAULT_SCOPE}). user grava na sua pasta pessoal; project grava na pasta atual.`,
    '--dry-run mostra o plano sem gravar nada. --force sobrescreve arquivo alheio guardando backup (.swarm-agents.bak).',
    'Manifesto: ~/.swarm-agents/manifest.json (ou $SWARM_AGENTS_HOME/manifest.json).',
    'Códigos de saída: 0 ok, 1 erro, 2 conflito.',
  ].join('\n');
}

function parse(command, args) {
  try {
    return parseArgs({ args, options: OPTIONS[command], strict: true, allowPositionals: false }).values;
  } catch (err) {
    const opt = /'([^']+)'/.exec(err.message)?.[1];
    const what = opt ? `"${opt}"` : 'argumento não reconhecido';
    throw new InstallerError(`Opção inválida para ${command}: ${what}. Veja: swarm-agents --help`, { code: 'OPCAO_INVALIDA' });
  }
}

function detectAll(adapters, { home, cwd, env }) {
  const detected = new Map();
  for (const a of adapters) {
    let ok = false;
    try {
      ok = Boolean(a.detect({ home, cwd, env }));
    } catch {
      ok = false;
    }
    detected.set(a.id, ok);
  }
  return detected;
}

function printSharedWarnings(out, plan) {
  if (!plan.warnings.length) return;
  out('ATENÇÃO (pasta compartilhada entre ferramentas; os destinos não mudam, a instalação segue):');
  for (const w of plan.warnings) out(`  - ${w.text}`);
}

function printPlan(out, plan) {
  out(`Plano (escopo ${plan.scope}, pasta ${plan.root}):`);
  for (const a of plan.actions) {
    const backup = a.op === 'update' ? ` (backup: ${a.backupPath})` : '';
    out(`  ${OP_LABEL[a.op].padEnd(12)} [${a.clients.join(', ')}] ${a.path}${backup}`);
  }
  if (plan.notes.length) {
    out('Avisos:');
    for (const n of plan.notes) out(`  [${n.client}] ${n.text}`);
  }
  printSharedWarnings(out, plan);
  const c = plan.counts;
  out(`Resumo: ${c.create} a criar, ${c.update} a atualizar, ${c.unchanged} sem mudança, ${c.conflict} conflito(s).`);
}

async function confirmOrFail({ values, ctx, prompter, question }) {
  if (values.yes) return true;
  if (!ctx.isTTY) {
    throw new InstallerError('Confirmação necessária: rode de novo com --yes (ou num terminal interativo).', { code: 'CONFIRMACAO' });
  }
  return prompter().confirm(question);
}

async function selectForInstall({ values, ctx, adapters, detected, out, prompter }) {
  if (values.client?.length) return resolveClients(values.client, adapters);
  if (values['all-detected']) {
    const chosen = adapters.filter((a) => detected.get(a.id) && a.defaultSelected);
    for (const a of adapters.filter((x) => detected.get(x.id) && !x.defaultSelected)) {
      out(`${a.id}: detectado, mas fica de fora do --all-detected; para instalar use --client ${a.id}.`);
    }
    if (chosen.length === 0) {
      throw new InstallerError('Nenhuma ferramenta detectada nesta máquina. Use --client <id> (veja: swarm-agents list).', { code: 'NADA_DETECTADO' });
    }
    return chosen;
  }
  if (ctx.isTTY && !values.yes) {
    const items = adapters.map((a) => ({
      id: a.id,
      label: a.name,
      hint: [detected.get(a.id) ? 'detectado' : 'não detectado', a.defaultSelected ? null : 'desmarcado por padrão'].filter(Boolean).join(', '),
    }));
    const pre = adapters.filter((a) => a.defaultSelected && detected.get(a.id)).map((a) => a.id);
    const ids = await prompter().multiselect('Em quais ferramentas instalar o /swarm?', items, pre);
    if (ids.length === 0) throw new InstallerError('Nenhuma ferramenta marcada; nada foi feito.', { code: 'NENHUM_CLIENTE' });
    return resolveClients(ids, adapters);
  }
  throw new InstallerError(
    `Informe a ferramenta com --client <id> (ou --all-detected). Ferramentas: ${adapters.map((a) => a.id).join(', ')}.`,
    { code: 'NENHUM_CLIENTE' },
  );
}

async function chooseScope({ values, ctx, prompter }) {
  if (values.scope !== undefined) return validateScope(values.scope);
  if (ctx.isTTY && !values.yes) {
    return prompter().choose('Escopo da instalação:', [
      { id: 'user', label: 'na sua pasta pessoal, vale para todos os projetos' },
      { id: 'project', label: `só neste projeto (${ctx.cwd})` },
    ], DEFAULT_SCOPE);
  }
  return DEFAULT_SCOPE;
}

async function cmdInstall(values, env) {
  const { ctx, adapters, out } = env;
  const detected = detectAll(adapters, ctx);
  const selected = await selectForInstall({ values, ...env, detected });
  const scope = await chooseScope({ values, ...env });
  const payload = await loadPayload(ctx.payloadDir);
  const mfile = manifestFile(ctx);
  const manifest = await loadManifest(mfile);
  const plan = await buildPlan({ adapters: selected, scope, home: ctx.home, cwd: ctx.cwd, payload, manifest, force: Boolean(values.force) });
  printPlan(out, plan);
  if (plan.counts.conflict > 0) throw conflictError(plan);
  if (values['dry-run']) {
    out('Simulação (--dry-run): nada foi gravado.');
    return EXIT.OK;
  }
  const changes = plan.counts.create + plan.counts.update;
  let question = `Aplicar ${changes} mudança(s)?`;
  if (plan.warnings.length && !values.yes && ctx.isTTY && changes > 0) {
    printSharedWarnings(out, plan);
    question = `Aplicar ${changes} mudança(s) mesmo com ${plan.warnings.length} aviso(s) de pasta compartilhada?`;
  }
  if (changes > 0 && !(await confirmOrFail({ values, ...env, question }))) {
    out('Instalação cancelada; nada foi alterado.');
    return EXIT.ERROR;
  }
  const res = await applyPlan(plan, { manifest, manifestFile: mfile });
  const written = res.results.filter((r) => r.status !== 'unchanged').length;
  if (written === 0) out('Nada a gravar: tudo já está atual.');
  else out(`Pronto: ${written} arquivo(s) gravado(s), ${plan.counts.unchanged} sem mudança.`);
  for (const b of res.backups) out(`Backup do arquivo anterior: ${b}`);
  out(`Manifesto: ${mfile}`);
  if (written > 0) out(`Reinicie ${selected.map((a) => a.name).join(', ')} para carregar a skill /swarm.`);
  return EXIT.OK;
}

async function cmdUninstall(values, env) {
  const { ctx, adapters, out } = env;
  const clients = values.client?.length ? resolveClients(values.client, adapters).map((a) => a.id) : null;
  const scope = values.scope !== undefined ? validateScope(values.scope) : null;
  const mfile = manifestFile(ctx);
  const manifest = await loadManifest(mfile);
  const actions = await planUninstall({ manifest, clients, scope });
  if (actions.length === 0) {
    out('Nada a remover: o manifesto não registra arquivos do swarm-agents para esse filtro.');
    return EXIT.OK;
  }
  out('Plano de remoção:');
  for (const a of actions) {
    const extra = a.op === 'detach' ? ` (continua instalado para ${a.remaining.join(', ')})` : '';
    out(`  ${UNINSTALL_LABEL[a.op].padEnd(12)} [${a.clients.join(', ')}] ${a.path}${extra}`);
  }
  if (values['dry-run']) {
    out('Simulação (--dry-run): nada foi removido.');
    return EXIT.OK;
  }
  if (!(await confirmOrFail({ values, ...env, question: `Aplicar a remoção de ${actions.length} registro(s)?` }))) {
    out('Remoção cancelada; nada foi alterado.');
    return EXIT.ERROR;
  }
  const res = await applyUninstall(actions, { manifest, manifestFile: mfile });
  out(`Pronto: ${res.removed.length} arquivo(s) removido(s), ${res.detached.length} desvinculado(s), ${res.missing.length} já ausente(s).`);
  if (res.kept.length) out(`${res.kept.length} arquivo(s) mantido(s) porque foram modificados por você: ${res.kept.join(', ')}`);
  if (res.skipped.length) out(`${res.skipped.length} registro(s) ignorado(s) por segurança (fora da pasta registrada, pasta ou link): ${res.skipped.join(', ')}`);
  return EXIT.OK;
}

async function cmdDoctor(_values, { ctx, adapters, out }) {
  const payload = await loadPayload(ctx.payloadDir);
  const mfile = manifestFile(ctx);
  const manifest = await loadManifest(mfile);
  const report = await runDoctor({ adapters, manifest, manifestFile: mfile, payload, home: ctx.home, nodeVersion: ctx.nodeVersion });
  for (const c of report.checks) out(`[${c.level}] ${c.text}`);
  return report.ok ? EXIT.OK : EXIT.ERROR;
}

function cmdList(_values, { ctx, adapters, out }) {
  const detected = detectAll(adapters, ctx);
  out('Ferramentas disponíveis:');
  for (const a of adapters) {
    out(
      `  ${a.id.padEnd(12)} ${String(a.name).padEnd(16)} ${(detected.get(a.id) ? 'detectado' : 'não detectado').padEnd(14)} ` +
        `${a.defaultSelected ? 'marcado por padrão' : 'desmarcado por padrão'}  verificação: ${a.verified}`,
    );
    for (const n of a.notes ?? []) out(`      - ${n}`);
  }
  return EXIT.OK;
}

const HANDLERS = { install: cmdInstall, uninstall: cmdUninstall, doctor: cmdDoctor, list: cmdList };

/**
 * @param {string[]} argv argumentos sem "node" e sem o script
 * @param {object} ctx contexto (veja createDefaultContext)
 * @returns {Promise<number>} código de saída
 */
export async function main(argv, ctx) {
  const out = (s = '') => ctx.stdout.write(`${s}\n`);
  const err = (s) => ctx.stderr.write(`${s}\n`);
  let prompterInstance = null;
  const prompter = () => (prompterInstance ??= createPrompter({ input: ctx.stdin, output: ctx.stdout }));
  try {
    /* node:coverage ignore next */
    const adapters = ctx.adapters ?? loadAdapters(await import('../adapters/index.mjs'));
    const first = argv[0];
    const isHelp = first === 'help' || first === '--help' || first === '-h';
    const command = isHelp ? 'help' : first === undefined || first.startsWith('-') ? 'install' : first;
    const rest = isHelp || command === first ? argv.slice(1) : argv;
    if (!OPTIONS[command]) {
      throw new InstallerError(`Comando desconhecido: ${JSON.stringify(String(command).slice(0, 40))}. Use install, uninstall, doctor ou list.`, { code: 'COMANDO_DESCONHECIDO' });
    }
    const values = parse(command, rest);
    if (command === 'help' || values.help) {
      out(helpText(adapters));
      return EXIT.OK;
    }
    return await HANDLERS[command](values, { ctx, adapters, out, prompter });
  } catch (e) {
    if (e instanceof InstallerError) {
      err(e.message);
      return e.exitCode;
    }
    err(`Erro inesperado: ${e?.message ?? String(e)}. Rode swarm-agents doctor para conferir o estado da instalação.`);
    return EXIT.ERROR;
  } finally {
    prompterInstance?.close();
  }
}
