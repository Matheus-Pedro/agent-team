#!/usr/bin/env node
// Hook UserPromptSubmit: é o ÚNICO lugar onde aprovações são registradas.
// Roda apenas quando o usuário envia uma mensagem, então o modelo não consegue
// disparar uma aprovação por conta própria.
//
// Primeira linha da mensagem:
//   APROVAR G1 | G2 | G3 | G4 | PROD
//   REPROVAR G2 <motivo>          (linhas seguintes também entram no motivo)
//
// Decisão incompleta (`APROVAR` sem gate, `APROVAR G9`, `REPROVAR`): NADA é
// escrito e a sessão recebe um aviso com o gate em espera e o comando exato
// (US-08 / ADR-006). O reconhecimento fica em lib/prompt-rules.mjs.

import fs from 'node:fs';
import { findTeamRoot, recordDecision, loadState, TeamError } from '../lib/core.mjs';
import { classifyPrompt, waitingGate } from '../lib/prompt-rules.mjs';

const MAX_ECHO = 120; // o eco do que foi digitado é curto por construção; corta por segurança

function emit(context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }),
  );
}

/**
 * Caminho de decisão incompleta: lê o estado (sem alterá-lo) só para nomear o
 * gate em espera. Qualquer falha resulta em silêncio.
 */
function warnIncompleteDecision(root, cls) {
  let state;
  try {
    state = loadState(root);
  } catch {
    return; // estado ilegível: nada a dizer
  }
  if (!state || !state.work) return; // sem work item ativo: silêncio (CA-08.5)

  const typed = cls.typed.slice(0, MAX_ECHO);
  const gate = waitingGate(state.status);
  if (!gate) {
    emit(
      `[agent-team] ⚠️ Você digitou "${typed}", mas NADA foi aprovado nem reprovado: nenhum gate está ` +
        `aguardando decisão agora. O work item ${state.work.id} está em ${state.status}. ` +
        'Peça o status ao Orchestrator (`team status`) antes de decidir.',
    );
    return;
  }
  const command = cls.verb === 'reject' ? `REPROVAR ${gate} <motivo>` : `APROVAR ${gate}`;
  const other = cls.verb === 'reject' ? `APROVAR ${gate}` : `REPROVAR ${gate} <motivo>`;
  emit(
    `[agent-team] ⚠️ Você digitou "${typed}", mas NADA foi aprovado nem reprovado. O gate ${gate} está ` +
      `aguardando a sua decisão em ${state.status}. Digite exatamente: ${command} (ou ${other}).`,
  );
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  const cls = classifyPrompt(input.prompt);
  if (cls.kind === 'none') return; // conversa: mensagem normal

  const root = findTeamRoot(input.cwd || process.cwd());
  if (!root) return; // projeto sem time de agentes: mensagem normal

  if (cls.kind === 'intent') {
    try {
      warnIncompleteDecision(root, cls);
    } catch {
      /* nada é escrito e nada é dito */
    }
    return;
  }

  const { gate, note, verb } = cls;
  try {
    const rec = recordDecision(root, { gate, decision: verb === 'approve' ? 'approved' : 'rejected', note });
    const state = loadState(root);
    if (verb === 'approve') {
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
      `[agent-team] ⚠️ O usuário digitou "${cls.typed}", mas NADA foi registrado: ${msg} ` +
        'Informe isso ao usuário. Não trate a mensagem como aprovação.',
    );
  }
}

main();
