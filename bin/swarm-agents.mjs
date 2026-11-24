#!/usr/bin/env node
// Ponto de entrada da CLI. Toda a lógica está em installer/cli.mjs (testável sem processo).
import { main, createDefaultContext } from '../installer/cli.mjs';

process.exitCode = await main(process.argv.slice(2), createDefaultContext());
