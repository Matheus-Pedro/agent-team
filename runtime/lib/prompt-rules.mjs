// Regras de reconhecimento da mensagem do usuário no hook UserPromptSubmit.
// Separado de hooks/prompt-approval.mjs (que fica só com I/O, estado e texto)
// pelo mesmo motivo de guard-rules.mjs: a classificação precisa ser testável
// sem spawn. Ver ADR-006 e contracts.md §4.
//
// Não escreve nada em disco e não lê estado: é uma função pura da mensagem.

import { GATE_STATE } from './core.mjs';

const APPROVE_VERBS = new Set(['aprovar', 'aprovo', 'aprovado']);
const REJECT_VERBS = new Set(['reprovar', 'reprovo', 'rejeitar', 'rejeito']);

// Pontuação final que não muda o sentido da linha ("APROVAR!", "APROVAR G1.").
// Exatamente o conjunto do ADR-006, passo 2: `. ! : ,` e `…`. NÃO inclua `?` nem `;`:
// "APROVAR G1?" é uma pergunta, e tratá-la como decisão gravaria uma aprovação
// assinada contra a intenção do usuário. Com `?`/`;` colados, o token deixa de ser
// gate (nem válido nem gate-like) e a linha cai em `none` (conversa).
const TRAILING_PUNCT_RE = /[.!:,…]+$/;
// Gate que o runtime aceita de fato.
const VALID_GATE_RE = /^(g[1-4]|prod)$/i;
// "Parece um gate" mas pode não existir (G9, GX, G0, prodX): intenção de decidir.
const GATE_LIKE_RE = /^(g\d{1,2}|g[a-z]|prod\w*)$/i;
// Separadores entre o gate e o motivo, no formato aceito na v1.0.
const NOTE_SEP_RE = /^[\s:.,—–-]+/;

/** Estado da máquina → gate que está aguardando decisão (mapa reverso de GATE_STATE). */
const WAITING_GATE = Object.fromEntries(Object.entries(GATE_STATE).map(([gate, state]) => [state, gate]));

/** @returns {'G1'|'G2'|'G3'|'G4'|'PROD'|null} */
export function waitingGate(status) {
  return WAITING_GATE[String(status || '')] || null;
}

function verbOf(token) {
  const t = token.toLowerCase();
  if (APPROVE_VERBS.has(t)) return 'approve';
  if (REJECT_VERBS.has(t)) return 'reject';
  return null;
}

/** Motivo: o que sobra da primeira linha depois do gate, mais as linhas seguintes. */
function buildNote(firstLine, rest, { fromFirstLine }) {
  let head = '';
  if (fromFirstLine) {
    const consumed = firstLine.match(/^\S+\s+\S+/);
    head = consumed ? firstLine.slice(consumed[0].length).replace(NOTE_SEP_RE, '') : '';
  }
  return [head, ...rest].join('\n').trim();
}

/**
 * Classifica a mensagem do usuário olhando apenas a PRIMEIRA linha (US-08/RF-14):
 * só é decisão (ou intenção de decisão) quando a linha tem o verbo e, no máximo,
 * um token de gate. Qualquer outra palavra é conversa.
 *
 * @param {string} prompt
 * @returns {{kind:'none'|'decision'|'intent', verb:'approve'|'reject'|null,
 *            gate:'G1'|'G2'|'G3'|'G4'|'PROD'|null, note:string, typed:string}}
 */
export function classifyPrompt(prompt) {
  const [firstRaw = '', ...rest] = String(prompt ?? '').split(/\r?\n/);
  const typed = firstRaw.trim();
  const none = { kind: 'none', verb: null, gate: null, note: '', typed };

  const line = typed.replace(TRAILING_PUNCT_RE, '');
  if (!line) return none;

  const tokens = line.split(/\s+/);
  const verb = verbOf(tokens[0]);
  if (!verb) return none; // verbo fora da primeira posição = conversa (CA-08.6)

  // Só o verbo: intenção de decidir, sem gate (CA-08.1, CA-08.3).
  if (tokens.length === 1) return { kind: 'intent', verb, gate: null, note: '', typed };

  const gateToken = tokens[1].replace(TRAILING_PUNCT_RE, '');

  if (VALID_GATE_RE.test(gateToken)) {
    const gate = gateToken.toUpperCase();
    // Aprovação aceita apenas "APROVAR <G>": "APROVAR G1 mas mude o RF-02" é conversa.
    if (verb === 'approve' && tokens.length > 2) return none;
    return {
      kind: 'decision',
      verb,
      gate,
      note: buildNote(typed, rest, { fromFirstLine: verb === 'reject' }),
      typed,
    };
  }

  // Parece gate, mas não existe (G9, GX, G0, prodX) → intenção (CA-08.2, CA-08.3).
  // Na aprovação, só quando não há mais nada na linha; na reprovação, o resto é motivo.
  if (GATE_LIKE_RE.test(gateToken) && (verb === 'reject' || tokens.length === 2)) {
    return { kind: 'intent', verb, gate: null, note: '', typed };
  }

  return none; // "APROVAR isso", "aprovo o orçamento"
}
