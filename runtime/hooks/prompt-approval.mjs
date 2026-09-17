#!/usr/bin/env node
// Hook UserPromptSubmit: é o ÚNICO lugar onde aprovações são registradas.
// Roda apenas quando o usuário envia uma mensagem, então o modelo não consegue
// disparar uma aprovação por conta própria.
//
// Primeira linha da mensagem:
//   APROVAR G1 | G2 | G3 | G4 | PROD
//   REPROVAR G2 <motivo>          (linhas seguintes também entram no motivo)

import fs from 'node:fs';
import { findTeamRoot, recordDecision, loadState, TeamError } from '../lib/core.mjs';

const APPROVE_RE = /^\s*(?:aprovar|aprovo|aprovado)\s+(g[1-4]|prod)\s*[.!]?\s*$/i;
const REJECT_RE = /^\s*(?:reprovar|reprovo|rejeitar|rejeito)\s+(g[1-4]|prod)\b[\s:.,—-]*(.*)$/i;

function emit(context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }),
  );
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  const prompt = String(input.prompt || '');
  const [first = '', ...rest] = prompt.split(/\r?\n/);
  const approve = first.match(APPROVE_RE);
  const reject = approve ? null : first.match(REJECT_RE);
  if (!approve && !reject) return;

  const root = findTeamRoot(input.cwd || process.cwd());
  if (!root) return; // projeto sem time de agentes: mensagem normal

  const gate = (approve || reject)[1].toUpperCase();
  const note = approve ? rest.join('\n').trim() : [reject[2], ...rest].join('\n').trim();

  try {
    const rec = recordDecision(root, { gate, decision: approve ? 'approved' : 'rejected', note });
    const state = loadState(root);
    if (approve) {
      emit(
        `[agent-team] ✅ O USUÁRIO APROVOU ${gate} para ${rec.work_id} (registro assinado em .team/approvals). ` +
          `Estado atual: ${state.status}. Avance com \`team move\` para a próxima fase.` +
          (note ? ` Observações do usuário junto com a aprovação: ${note}` : ''),
      );
    } else {
      emit(
        `[agent-team] ❌ O USUÁRIO REPROVOU ${gate} para ${rec.work_id}. Motivo: ${note || '(não informado — pergunte)'}. ` +
          'Volte para a fase anterior com `team move` (retrabalho) e use o motivo como entrada do agente responsável.',
      );
    }
  } catch (err) {
    const msg = err instanceof TeamError ? err.message : String(err);
    emit(
      `[agent-team] ⚠️ O usuário digitou "${first.trim()}", mas NADA foi registrado: ${msg} ` +
        'Informe isso ao usuário. Não trate a mensagem como aprovação.',
    );
  }
}

main();
