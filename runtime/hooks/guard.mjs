#!/usr/bin/env node
// Hook PreToolUse: bloqueia (exit 2) ações que dependem de aprovação humana ou
// que alterariam o estado/aprovações do time por fora do runtime.

import fs from 'node:fs';
import { evaluateToolCall } from '../lib/guard-rules.mjs';

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

let result;
try {
  result = evaluateToolCall(input);
} catch (err) {
  // Falha inesperada do guard não deve travar sessões fora do fluxo do time.
  process.stderr.write(`[agent-team guard] erro interno ignorado: ${err.message}\n`);
  process.exit(0);
}

if (result.deny) {
  process.stderr.write(
    `[agent-team] BLOQUEADO: ${result.reason}\n` +
      'Não tente contornar este bloqueio com outro comando. Pare e reporte ao Orchestrator/usuário.\n',
  );
  process.exit(2);
}
process.exit(0);
