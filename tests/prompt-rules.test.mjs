// Classificação da mensagem do usuário (US-08 / ADR-006): função pura, sem spawn
// e sem tocar em disco. O comportamento do hook em si fica em hooks.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from './helpers.mjs'; // fixa um AGENT_TEAM_HOME temporário antes de importar core
import { classifyPrompt, waitingGate } from '../runtime/lib/prompt-rules.mjs';

const kinds = (prompts) => prompts.map((p) => [p, classifyPrompt(p).kind]);

test('decisão completa continua sendo decisão (regressão CA-08.8)', () => {
  assert.deepEqual(classifyPrompt('APROVAR G1'), {
    kind: 'decision', verb: 'approve', gate: 'G1', note: '', typed: 'APROVAR G1',
  });
  assert.deepEqual(classifyPrompt('aprovar g1'), {
    kind: 'decision', verb: 'approve', gate: 'G1', note: '', typed: 'aprovar g1',
  });
  assert.equal(classifyPrompt('APROVAR PROD.').gate, 'PROD');
  assert.equal(classifyPrompt('  aprovado g4 ').gate, 'G4');

  const comNota = classifyPrompt('APROVAR G1\nconsidere multi-empresa na v2');
  assert.equal(comNota.kind, 'decision');
  assert.equal(comNota.note, 'considere multi-empresa na v2');

  const reprova = classifyPrompt('REPROVAR G1: faltou controle de lote\ne validade');
  assert.equal(reprova.kind, 'decision');
  assert.equal(reprova.verb, 'reject');
  assert.equal(reprova.gate, 'G1');
  assert.equal(reprova.note, 'faltou controle de lote\ne validade');
  assert.equal(classifyPrompt('rejeito G2 — sem ADR').note, 'sem ADR');
});

test('CA-08.1 verbo de aprovação sem gate é intenção, em qualquer caixa', () => {
  for (const p of ['APROVAR', 'aprovar', 'APROVO', 'Aprovo', 'APROVADO', 'aprovado', 'APROVAR!', 'aprovado.']) {
    const r = classifyPrompt(p);
    assert.equal(r.kind, 'intent', p);
    assert.equal(r.verb, 'approve', p);
    assert.equal(r.gate, null, p);
    assert.equal(r.typed, p.trim(), p);
  }
});

test('CA-08.2 gate inexistente com cara de gate é intenção', () => {
  for (const p of ['APROVAR G9', 'APROVAR GX', 'APROVAR G0', 'aprovar g12', 'APROVAR PRODUCAO']) {
    const r = classifyPrompt(p);
    assert.equal(r.kind, 'intent', p);
    assert.equal(r.verb, 'approve', p);
    assert.equal(r.gate, null, p);
  }
});

test('CA-08.3 verbos de reprovação incompletos são intenção, com ou sem motivo', () => {
  for (const p of ['REPROVAR', 'REPROVO', 'REJEITAR', 'REJEITO', 'reprovar g9', 'REPROVAR G9 faltou o ADR']) {
    const r = classifyPrompt(p);
    assert.equal(r.kind, 'intent', p);
    assert.equal(r.verb, 'reject', p);
    assert.equal(r.gate, null, p);
  }
});

test('CA-08.6 conversa continua silenciosa', () => {
  const frases = [
    'precisamos aprovar isso amanhã',
    'o cliente aprovou o orçamento',
    'vamos revisar antes de aprovar',
    'acho que dá pra APROVAR G1',
    'ok, pode seguir',
  ];
  assert.deepEqual(kinds(frases), frases.map((f) => [f, 'none']));
});

test('palavra extra na primeira linha é conversa (RF-14)', () => {
  const frases = [
    'APROVAR G1 mas mude o RF-02',
    'APROVAR isso',
    'aprovo o orçamento',
    'APROVAR G9 mas antes veja o ADR',
    '',
    '   ',
  ];
  assert.deepEqual(kinds(frases), frases.map((f) => [f, 'none']));
  assert.equal(classifyPrompt(undefined).kind, 'none');
  assert.equal(classifyPrompt(null).kind, 'none');
});

test('pergunta ou ";" depois do gate nunca é decisão (ADR-006 passo 2: só . ! : , …)', () => {
  const perguntas = ['APROVAR G1?', 'Aprovado G1?', 'APROVAR G1;', 'REPROVAR G1?', 'APROVAR PROD?', 'APROVAR G1 ?',
    'APROVAR G1?!', 'REPROVAR G1; faltou o ADR', 'APROVAR?', 'aprovado?'];
  for (const p of perguntas) {
    const r = classifyPrompt(p);
    assert.notEqual(r.kind, 'decision', p);
    assert.equal(r.gate, null, p);
  }
  // Regra do ADR: `?`/`;` não são removidos, então o token não é gate nem gate-like → conversa.
  assert.deepEqual(kinds(perguntas), perguntas.map((p) => [p, 'none']));

  // A pontuação permitida continua valendo.
  for (const [p, gate] of [['APROVAR G1', 'G1'], ['APROVAR PROD.', 'PROD'], ['APROVAR G1!', 'G1'],
    ['APROVAR G2,', 'G2'], ['APROVAR G3:', 'G3'], ['APROVAR G4…', 'G4']]) {
    const r = classifyPrompt(p);
    assert.equal(r.kind, 'decision', p);
    assert.equal(r.gate, gate, p);
  }
});

test('a classificação olha só a primeira linha', () => {
  assert.equal(classifyPrompt('APROVAR\nG1').kind, 'intent'); // gate na linha seguinte não vale
  assert.equal(classifyPrompt('resumo do dia\nAPROVAR G1').kind, 'none');
  assert.equal(classifyPrompt('APROVAR G1\r\nobservação').note, 'observação');
  assert.equal(classifyPrompt('APROVAR\nqualquer coisa').note, ''); // intenção nunca carrega motivo
});

test('waitingGate é o mapa reverso de GATE_STATE', () => {
  for (const [gate, state] of Object.entries(core.GATE_STATE)) assert.equal(waitingGate(state), gate);
  for (const state of ['PLANNING', 'IMPLEMENTING', 'IDLE', 'DONE', '', undefined, null]) {
    assert.equal(waitingGate(state), null, String(state));
  }
});
