// Perguntas no terminal com node:readline (sem dependências). As linhas são lidas por um iterador,
// que guarda em buffer o que chegou antes da pergunta (necessário quando a entrada vem de um pipe).
import { createInterface } from 'node:readline';
import { InstallerError } from './errors.mjs';

const YES = new Set(['s', 'sim', 'y', 'yes']);
const NO = new Set(['n', 'nao', 'não', 'no', '']);

function cancelled() {
  return new InstallerError('Operação cancelada; nada foi alterado.', { code: 'CANCELADO' });
}

export function createPrompter({ input, output }) {
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const write = (s) => output.write(s);

  async function ask(question) {
    write(question);
    const { value, done } = await lines.next();
    if (done) throw cancelled();
    return value.trim();
  }

  async function multiselect(title, items, preselected = []) {
    const selected = new Set(preselected);
    for (;;) {
      write(`${title}\n`);
      items.forEach((it, i) => {
        const hint = it.hint ? ` (${it.hint})` : '';
        write(`  ${i + 1}) [${selected.has(it.id) ? 'x' : ' '}] ${it.label}${hint}\n`);
      });
      const answer = (await ask('Números para marcar/desmarcar (ex.: 1 3), "todos" ou "nenhum"; Enter confirma: ')).toLowerCase();
      if (answer === '') return items.filter((it) => selected.has(it.id)).map((it) => it.id);
      if (answer === 'todos') {
        for (const it of items) selected.add(it.id);
        continue;
      }
      if (answer === 'nenhum') {
        selected.clear();
        continue;
      }
      const nums = answer.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (!nums.every((n) => Number.isInteger(n) && n >= 1 && n <= items.length)) {
        write(`Opção inválida: use números de 1 a ${items.length}.\n`);
        continue;
      }
      for (const n of nums) {
        const id = items[n - 1].id;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
    }
  }

  async function choose(question, options, defaultId) {
    for (;;) {
      write(`${question}\n`);
      options.forEach((o, i) => write(`  ${i + 1}) ${o.id}: ${o.label}${o.id === defaultId ? ' (padrão)' : ''}\n`));
      const answer = (await ask('Escolha (Enter = padrão): ')).toLowerCase();
      if (answer === '') return defaultId;
      const byNumber = options[Number(answer) - 1];
      if (/^\d+$/.test(answer) && byNumber) return byNumber.id;
      const byId = options.find((o) => o.id === answer);
      if (byId) return byId.id;
      write('Opção inválida.\n');
    }
  }

  async function confirm(question) {
    for (;;) {
      const answer = (await ask(`${question} [s/N] `)).toLowerCase();
      if (YES.has(answer)) return true;
      if (NO.has(answer)) return false;
      write('Responda s (sim) ou n (não).\n');
    }
  }

  return { ask, multiselect, choose, confirm, close: () => rl.close() };
}
