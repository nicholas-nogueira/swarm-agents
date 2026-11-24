// Testes unitários dos módulos compartilhados dos adapters: texto, frontmatter, TOML, caminhos e payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AdapterError } from '../../adapters/lib/errors.mjs';
import { toPosix, normalizeEol, replaceOnce, replaceLine, assertNone } from '../../adapters/lib/text.mjs';
import { parseFrontmatter, buildFrontmatter } from '../../adapters/lib/frontmatter.mjs';
import { tomlString, tomlMultiline } from '../../adapters/lib/toml.mjs';
import { assertScope, assertAbsolute, dirExists, fileExists } from '../../adapters/lib/paths.mjs';
import { assertPayload, textOf, skillEntries } from '../../adapters/lib/payload.mjs';
import { mockPayload, makeTmp, writeTree } from './helpers.mjs';

// ---------- text ----------
test('toPosix troca barras invertidas por barras normais', () => {
  assert.equal(toPosix('C:\\a\\b/c'), 'C:/a/b/c');
});

test('normalizeEol converte CRLF e CR em LF', () => {
  assert.equal(normalizeEol('a\r\nb\rc\n'), 'a\nb\nc\n');
});

test('replaceOnce troca o trecho sem interpretar $ no texto novo', () => {
  assert.equal(replaceOnce('x A y', 'A', '$& $1', 'rótulo'), 'x $& $1 y');
});

test('replaceOnce falha com mensagem amigável quando o trecho não existe', () => {
  assert.throws(() => replaceOnce('abc', 'Z', 'q', 'linha do board'), (e) => {
    assert.ok(e instanceof AdapterError);
    assert.equal(e.code, 'PAYLOAD_INCOMPATIVEL');
    assert.match(e.message, /linha do board/);
    return true;
  });
});

test('replaceLine troca exatamente uma linha e recusa zero ou várias', () => {
  assert.equal(replaceLine('a\nXX 1\nb', /^XX \d$/m, 'novo', 'x'), 'a\nnovo\nb');
  assert.throws(() => replaceLine('a\nb', /^XX$/m, 'n', 'x'), { code: 'PAYLOAD_INCOMPATIVEL' });
  assert.throws(() => replaceLine('XX\nXX', /^XX$/m, 'n', 'x'), { code: 'PAYLOAD_INCOMPATIVEL' });
});

test('assertNone passa sem ocorrências e falha citando o padrão restante', () => {
  assert.doesNotThrow(() => assertNone('limpo', [/FOO/], 'SKILL.md'));
  assert.throws(() => assertNone('tem FOO aqui', [/FOO/], 'SKILL.md'), (e) => {
    assert.equal(e.code, 'PAYLOAD_INCOMPATIVEL');
    assert.match(e.message, /SKILL\.md/);
    assert.match(e.message, /FOO/);
    return true;
  });
});

// ---------- frontmatter ----------
test('parseFrontmatter lê pares simples, remove aspas e devolve o corpo', () => {
  const { data, body } = parseFrontmatter('---\nname: swarm\ndescription: "a: b, #c"\nmodel: inherit\n---\n\n# Corpo\n');
  assert.deepEqual(data, { name: 'swarm', description: 'a: b, #c', model: 'inherit' });
  assert.equal(body, '\n# Corpo\n');
});

test('parseFrontmatter aceita CRLF, BOM e aspas simples', () => {
  const { data } = parseFrontmatter("\uFEFF---\r\nname: 'x'\r\n---\r\ncorpo");
  assert.equal(data.name, 'x');
});

test('parseFrontmatter recusa texto sem frontmatter e linha que não é chave: valor', () => {
  assert.throws(() => parseFrontmatter('# sem frontmatter'), { code: 'FRONTMATTER_AUSENTE' });
  assert.throws(() => parseFrontmatter('---\nname: a\n  continuação\n---\n'), { code: 'FRONTMATTER_INVALIDO' });
});

test('parseFrontmatter ignora linhas em branco dentro do frontmatter', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\n\nb: c\n---\n').data, { name: 'a', b: 'c' });
});

test('buildFrontmatter cita o que o YAML leria errado (# comentário, dois-pontos, colchete)', () => {
  const out = buildFrontmatter({ name: 'swarm', description: 'usa @menções, #seq e [done]: ok', flag: true, n: 3 });
  assert.equal(out, '---\nname: swarm\ndescription: "usa @menções, #seq e [done]: ok"\nflag: true\nn: 3\n---\n');
});

test('buildFrontmatter escreve listas simples em linha e listas de objetos em bloco', () => {
  const out = buildFrontmatter({
    tools: ['read_file', 'run_command'],
    permissions: [{ action: 'edit', resource: '*', effect: 'deny' }],
  });
  assert.equal(out, '---\ntools: [read_file, run_command]\npermissions:\n  - action: edit\n    resource: "*"\n    effect: deny\n---\n');
});

test('buildFrontmatter recusa valor que não sabe escrever', () => {
  assert.throws(() => buildFrontmatter({ x: { a: 1 } }), { code: 'FRONTMATTER_INVALIDO' });
  assert.throws(() => buildFrontmatter({ x: [{ a: { b: 1 } }] }), { code: 'FRONTMATTER_INVALIDO' });
});

test('buildFrontmatter com ida e volta preserva a descrição', () => {
  const desc = 'Runs "swarm" (Preview) com #seq e acentuação: ação';
  const { data } = parseFrontmatter(buildFrontmatter({ name: 'a', description: desc }));
  assert.equal(data.description, desc);
});

// ---------- toml ----------
test('tomlString escapa aspas, barra invertida e quebra de linha', () => {
  assert.equal(tomlString('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
});

test('tomlMultiline escapa barra, aspas triplas e controles, e preserva acentos', () => {
  const out = tomlMultiline('linha "x" \\ """ ação\ttab\u0001');
  assert.ok(out.startsWith('"""\n') && out.endsWith('"""'));
  assert.ok(out.includes('\\\\'));
  assert.ok(out.includes('""\\"'));
  assert.ok(out.includes('ação\ttab\\u0001'));
});

// ---------- paths ----------
test('assertScope aceita user e project e recusa o resto (OWASP: valida entrada)', () => {
  assert.equal(assertScope('user'), 'user');
  assert.equal(assertScope('project'), 'project');
  for (const bad of ['', 'USER', '../x', undefined, null, 'global']) {
    assert.throws(() => assertScope(bad), { code: 'ESCOPO_INVALIDO' });
  }
});

test('assertAbsolute exige caminho absoluto', () => {
  const abs = process.platform === 'win32' ? 'C:\\x' : '/x';
  assert.equal(assertAbsolute('home', abs), abs);
  assert.throws(() => assertAbsolute('home', 'relativo/x'), { code: 'CAMINHO_INVALIDO' });
  assert.throws(() => assertAbsolute('home', undefined), { code: 'CAMINHO_INVALIDO' });
});

test('dirExists e fileExists distinguem diretório, arquivo e ausência', async (t) => {
  const tmp = await makeTmp();
  t.after(tmp.cleanup);
  await writeTree(tmp.dir, { 'd/a.txt': 'x' });
  assert.equal(dirExists(join(tmp.dir, 'd')), true);
  assert.equal(dirExists(join(tmp.dir, 'd', 'a.txt')), false);
  assert.equal(fileExists(join(tmp.dir, 'd', 'a.txt')), true);
  assert.equal(fileExists(join(tmp.dir, 'd')), false);
  assert.equal(dirExists(join(tmp.dir, 'nao')), false);
  assert.equal(dirExists(undefined), false);
  assert.equal(fileExists(undefined), false);
});

// ---------- payload ----------
test('assertPayload aceita um payload completo', () => {
  assert.doesNotThrow(() => assertPayload(mockPayload()));
});

test('assertPayload recusa o que não é Map e payload incompleto, citando o que falta', () => {
  assert.throws(() => assertPayload({}), { code: 'PAYLOAD_INCOMPLETO' });
  const p = mockPayload();
  p.delete('agents/swarm-verifier.md');
  assert.throws(() => assertPayload(p), (e) => {
    assert.equal(e.code, 'PAYLOAD_INCOMPLETO');
    assert.match(e.message, /agents\/swarm-verifier\.md/);
    return true;
  });
});

test('textOf devolve o texto UTF-8 de um Buffer e falha para arquivo ausente', () => {
  assert.equal(textOf(mockPayload(), 'agents/swarm-worker.md').startsWith('---'), true);
  assert.throws(() => textOf(new Map(), 'x'), { code: 'PAYLOAD_INCOMPLETO' });
});

test('skillEntries lista só arquivos da skill, em ordem estável, com o caminho relativo à skill', () => {
  const entries = skillEntries(mockPayload());
  const rels = entries.map((e) => e.rel);
  assert.deepEqual(rels, [...rels].sort());
  assert.ok(rels.includes('SKILL.md') && rels.includes('scripts/board.mjs'));
  assert.ok(!rels.some((r) => r.startsWith('agents/')));
  assert.ok(Buffer.isBuffer(entries[0].content));
});

// ---------- toml: ida e volta com um decodificador mínimo de string multilinha básica ----------
function decodeTomlMultiline(src) {
  assert.ok(src.startsWith('"""\n') && src.endsWith('"""'));
  const inner = src.slice(4, -3);
  return inner.replace(/\\(u[0-9A-F]{4}|.)/g, (_m, c) => {
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { '\\': '\\', '"': '"', n: '\n', t: '\t' }[c];
  });
}

test('tomlMultiline faz ida e volta sem perder nada, inclusive aspas no fim e barras', () => {
  const casos = [
    'simples',
    'com "aspas" e \\ barra',
    'termina com aspas "',
    'aspas triplas """ no meio',
    'quatro """" seguidas',
    'tab\te controle \u0001 e acento ação',
    'linha 1\nlinha 2\n\nlinha 4\n',
  ];
  for (const c of casos) assert.equal(decodeTomlMultiline(tomlMultiline(c)), c, JSON.stringify(c));
});

test('parseFrontmatter tolera aspas duplas com escape inválido sem quebrar (usa o texto entre aspas)', () => {
  assert.equal(parseFrontmatter('---\nname: "a-b"\nx: "q\\qz"\n---\n').data.x, 'q\\qz');
});
