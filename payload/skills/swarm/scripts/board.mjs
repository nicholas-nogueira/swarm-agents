#!/usr/bin/env node
// Ponto de entrada do board do /swarm. Toda a lógica está em lib/ (testada).
import { main } from './lib/cli.mjs';

// Lê o stdin inteiro; se nada chegar em 3 s (stdin aberto e vazio), segue sem texto.
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => { process.stdin.pause(); resolve(data); }, 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; timer.refresh(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

process.exitCode = await main(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(`${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
  readStdin,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  env: process.env,
});
