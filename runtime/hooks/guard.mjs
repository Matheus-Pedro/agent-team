#!/usr/bin/env node
// Hook PreToolUse: bloqueia (exit 2) ações que dependem de aprovação humana ou
// que alterariam o estado/aprovações do time por fora do runtime.
//
// Fail-closed escopado (ADR-005): erro interno bloqueia **dentro** de projeto com
// time ativo e continua liberando fora dele.
//
// Por que os imports das regras são dinâmicos: um import estático que falhe
// (módulo ausente numa instalação parcial, erro de sintaxe) derruba o node com
// exit 1, que o harness trata como **não** bloqueante — fail-open com time ativo.
// Por isso a descoberta do time ativo usa só `node:fs`/`node:path`, e as regras
// são carregadas depois, dentro do try.

import fs from 'node:fs';
import path from 'node:path';

const BYPASS_WARNING =
  'Não tente contornar este bloqueio com outro comando. Pare e reporte ao Orchestrator/usuário.\n';

/** Texto curto e de uma linha — nunca `err.stack`, nunca conteúdo de arquivo (RNF-04). */
const oneLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const errorLabel = (err) => `${oneLine(err?.name, 40) || 'Error'}: ${oneLine(err?.message, 300) || 'sem mensagem'}`;

/** Mesmo algoritmo de `core.findTeamRoot`, sem depender de nenhum módulo do runtime. */
function findTeamRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    try {
      if (fs.statSync(path.join(dir, '.team', 'config.json')).isFile()) return dir;
    } catch {
      /* continua subindo */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Há time ativo e o guard está ligado? Mesma regra de `guard-rules.enforcementContext`
 * (raiz pelo `cwd` ou pelo diretório do arquivo-alvo; config ilegível ⇒ aplica).
 * Nunca lança: na dúvida sobre **existir** time, não trava a sessão.
 */
function enforcementContext(input) {
  try {
    const toolInput = input?.tool_input || {};
    const cwd = input?.cwd || process.cwd();
    const filePath = toolInput.file_path || toolInput.notebook_path || toolInput.path || '';
    const root = findTeamRoot(cwd) || (filePath ? findTeamRoot(path.dirname(path.resolve(cwd, filePath))) : null);
    if (!root) return { root: null, enforcing: false };
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, '.team', 'config.json'), 'utf8'));
      return { root, enforcing: cfg?.enforce !== false };
    } catch {
      return { root, enforcing: true };
    }
  } catch (err) {
    process.stderr.write(`[agent-team guard] erro interno ao descobrir o contexto: ${errorLabel(err)}\n`);
    return { root: null, enforcing: false };
  }
}

function internalError(input, ctx, err) {
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

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  // Sem entrada legível não se sabe se há time ativo: libera (CA-05.3).
  process.exit(0);
}

const ctx = enforcementContext(input);
// Fora de projeto com time nada é avaliado: nem as regras são carregadas.
if (!ctx.root) process.exit(0);

let result;
try {
  const { evaluateToolCall } = await import('../lib/guard-rules.mjs');
  result = evaluateToolCall(input);
} catch (err) {
  internalError(input, ctx, err);
}

if (result?.deny) {
  process.stderr.write(`[agent-team] BLOQUEADO: ${result.reason}\n` + BYPASS_WARNING);
  process.exit(2);
}
process.exit(0);
