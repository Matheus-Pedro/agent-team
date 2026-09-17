#!/usr/bin/env node
// Hook PreToolUse: bloqueia (exit 2) ações que dependem de aprovação humana ou
// que alterariam o estado/aprovações do time por fora do runtime.
//
// Fail-closed escopado (ADR-005): erro interno bloqueia **dentro** de projeto com
// time ativo e continua liberando fora dele. O contexto é calculado antes e
// separadamente da avaliação, porque a exceção pode vir das próprias regras.

import fs from 'node:fs';
import { evaluateToolCall, enforcementContext } from '../lib/guard-rules.mjs';

const BYPASS_WARNING =
  'Não tente contornar este bloqueio com outro comando. Pare e reporte ao Orchestrator/usuário.\n';

/** Texto curto e de uma linha — nunca `err.stack`, nunca conteúdo de arquivo (RNF-04). */
const oneLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const errorLabel = (err) => `${oneLine(err?.name, 40) || 'Error'}: ${oneLine(err?.message, 300) || 'sem mensagem'}`;

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  // Sem entrada legível não se sabe se há time ativo: libera (CA-05.3).
  process.exit(0);
}

let ctx = { root: null, enforcing: false };
try {
  ctx = enforcementContext(input);
} catch (err) {
  process.stderr.write(`[agent-team guard] erro interno ao descobrir o contexto: ${errorLabel(err)}\n`);
}

let result;
try {
  result = evaluateToolCall(input);
} catch (err) {
  if (ctx.enforcing) {
    process.stderr.write(
      `[agent-team] BLOQUEADO: erro interno do guard ao avaliar ${oneLine(input?.tool_name, 60) || 'a ferramenta'} ` +
        `(${errorLabel(err)}).\n` +
        'Por segurança a ação foi bloqueada. Pare, informe o usuário e reporte o erro; se precisar desbloquear o ' +
        'projeto, só o usuário pode editar .team/config.json (enforce: false).\n' +
        BYPASS_WARNING,
    );
    process.exit(2);
  }
  // Fora de projeto com time (ou com enforce: false) um bug do guard não trava a sessão.
  process.stderr.write(`[agent-team guard] erro interno ignorado: ${errorLabel(err)}\n`);
  process.exit(0);
}

if (result.deny) {
  process.stderr.write(`[agent-team] BLOQUEADO: ${result.reason}\n` + BYPASS_WARNING);
  process.exit(2);
}
process.exit(0);
