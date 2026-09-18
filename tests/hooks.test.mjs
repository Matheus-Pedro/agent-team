// Testa os hooks como o Claude Code os executa: processo separado, JSON no stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { core, startedProject, initProject, tmpProject, REPO } from './helpers.mjs';

const run = (script, payload) =>
  spawnSync(process.execPath, [path.join(REPO, 'runtime', 'hooks', script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: process.env,
  });

const context = (res) => JSON.parse(res.stdout).hookSpecificOutput.additionalContext;

test('APROVAR G1 digitado pelo usuário registra a aprovação e libera a transição', () => {
  const root = startedProject();
  core.moveTo(root, 'WAITING_G1_APPROVAL');
  const res = run('prompt-approval.mjs', { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'aprovar g1' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(context(res), /APROVOU G1/);
  assert.ok(fs.existsSync(core.approvalFile(root, 'W-001-estoque', 'G1')));
  core.moveTo(root, 'ARCHITECTING');
});

test('mensagens informais não são aprovação', () => {
  const root = startedProject();
  core.moveTo(root, 'WAITING_G1_APPROVAL');
  // Silêncio: conversa comum e decisão com texto extra na primeira linha (RF-14).
  for (const prompt of ['ok, pode seguir', 'APROVAR G1 mas mude o RF-02', 'acho que dá pra APROVAR G1']) {
    const res = run('prompt-approval.mjs', { cwd: root, prompt });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', prompt);
  }
  // Conciliado na v1.1 (CA-08.1 / CA-08.8): 'aprovado' sozinho na primeira linha
  // deixou de ser silencioso — continua NÃO sendo aprovação, mas agora devolve
  // o aviso com o comando exato. Antes estava na lista de silêncio acima.
  for (const prompt of ['aprovado']) {
    const res = run('prompt-approval.mjs', { cwd: root, prompt });
    assert.equal(res.status, 0);
    assert.match(context(res), /NADA foi aprovado nem reprovado/, prompt);
    assert.match(context(res), /APROVAR G1/, prompt);
  }
  assert.equal(fs.existsSync(core.approvalFile(root, 'W-001-estoque', 'G1')), false);
});

test('observações nas linhas seguintes acompanham a aprovação', () => {
  const root = startedProject();
  core.moveTo(root, 'WAITING_G1_APPROVAL');
  const res = run('prompt-approval.mjs', { cwd: root, prompt: 'APROVAR G1\nconsidere multi-empresa na v2' });
  assert.match(context(res), /multi-empresa/);
});

test('aprovação fora do estado esperado é recusada e o modelo é avisado', () => {
  const root = startedProject();
  const res = run('prompt-approval.mjs', { cwd: root, prompt: 'APROVAR G2' });
  assert.match(context(res), /NADA foi registrado/);
  assert.equal(fs.existsSync(core.approvalFile(root, 'W-001-estoque', 'G2')), false);
});

test('REPROVAR registra o motivo', () => {
  const root = startedProject();
  core.moveTo(root, 'WAITING_G1_APPROVAL');
  const res = run('prompt-approval.mjs', { cwd: root, prompt: 'REPROVAR G1: faltou controle de lote\ne validade' });
  assert.match(context(res), /REPROVOU G1.*faltou controle de lote\ne validade/s);
  const rec = JSON.parse(fs.readFileSync(path.join(root, '.team', 'approvals', 'W-001-estoque', 'G1.rejected.json'), 'utf8'));
  assert.equal(rec.decision, 'rejected');
});

test('guard devolve exit 2 com motivo ao bloquear', () => {
  const root = startedProject();
  const res = run('guard.mjs', {
    hook_event_name: 'PreToolUse',
    cwd: root,
    tool_name: 'Write',
    tool_input: { file_path: path.join(root, '.team', 'state.json'), content: '{}' },
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /BLOQUEADO/);

  const ok = run('guard.mjs', { cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(ok.status, 0);
});

test('guard não quebra com entrada inválida', () => {
  const res = spawnSync(process.execPath, [path.join(REPO, 'runtime', 'hooks', 'guard.mjs')], {
    input: 'isso não é json',
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
});

// ---------------------------------------------------------------- US-08 no hook (ADR-006)
// A classificação pura está em prompt-rules.test.mjs; aqui o hook roda como no
// harness (processo separado) e conferimos o que ele emite e o que ele NÃO grava.

const approvalsDir = (root) => path.join(root, '.team', 'approvals', 'W-001-estoque');
const listApprovals = (root) => (fs.existsSync(approvalsDir(root)) ? fs.readdirSync(approvalsDir(root)) : []);
const decisionEvents = (root) => {
  const log = path.join(root, '.team', 'logs', 'orchestration.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.event === 'approved' || e.event === 'rejected');
};

/** CA-08.7 e CA-08.9 valem para todo aviso desta história. */
function assertIncompleteWarning(res, prompt) {
  assert.equal(res.status, 0, prompt);
  assert.equal(res.stderr, '', prompt);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit', prompt);
  const msg = out.hookSpecificOutput.additionalContext;
  assert.match(msg, /^\[agent-team\] /, prompt); // CA-08.9: prefixo
  assert.equal(/BLOQUEADO/.test(msg), false, prompt); // CA-08.9: não é bloqueio
  assert.match(msg, /NADA foi aprovado nem reprovado/, prompt); // CA-08.9: explícito
  assert.equal(/approval\.key|[0-9a-f]{64}/i.test(msg), false, prompt); // RNF-04
  return msg;
}

test('CA-08.1 APROVAR/APROVO/APROVADO sem gate: nada registrado e aviso com G1 e o comando exato', () => {
  const root = startedProject();
  core.moveTo(root, 'WAITING_G1_APPROVAL');
  for (const prompt of ['APROVAR', 'aprovar', 'APROVO', 'Aprovo', 'APROVADO', 'aprovado', 'Aprovar\nconsidere a v2']) {
    const msg = assertIncompleteWarning(run('prompt-approval.mjs', { cwd: root, prompt }), prompt);
    assert.match(msg, /gate G1 está aguardando/, prompt);
    assert.match(msg, /Digite exatamente: APROVAR G1/, prompt); // próximo passo (CA-08.9)
  }
  assert.deepEqual(listApprovals(root), []); // CA-08.7
  assert.deepEqual(decisionEvents(root), []);
});

test('CA-08.2 APROVAR G9/GX/G0: mesmo comportamento do CA-08.1', () => {
  const root = startedProject();
  core.moveTo(root, 'WAITING_G1_APPROVAL');
  for (const prompt of ['APROVAR G9', 'APROVAR GX', 'APROVAR G0']) {
    const msg = assertIncompleteWarning(run('prompt-approval.mjs', { cwd: root, prompt }), prompt);
    assert.match(msg, /Digite exatamente: APROVAR G1/, prompt);
  }
  assert.deepEqual(listApprovals(root), []);
  assert.deepEqual(decisionEvents(root), []);
});

test('CA-08.3 REPROVAR/REPROVO/REJEITAR/REJEITO sem gate: aviso com REPROVAR G1 <motivo>', () => {
  const root = startedProject();
  core.moveTo(root, 'WAITING_G1_APPROVAL');
  for (const prompt of ['REPROVAR', 'REPROVO', 'REJEITAR', 'REJEITO', 'REPROVAR G9', 'reprovar']) {
    const msg = assertIncompleteWarning(run('prompt-approval.mjs', { cwd: root, prompt }), prompt);
    assert.match(msg, /Digite exatamente: REPROVAR G1 <motivo>/, prompt);
  }
  assert.deepEqual(listApprovals(root), []);
  assert.deepEqual(decisionEvents(root), []);
});

test('CA-08.4 fase que não aguarda decisão: aviso sem gate, com o estado atual', () => {
  const root = startedProject(); // recém-iniciado: PLANNING
  assert.equal(core.loadState(root).status, 'PLANNING');
  for (const prompt of ['APROVAR', 'REPROVAR']) {
    const msg = assertIncompleteWarning(run('prompt-approval.mjs', { cwd: root, prompt }), prompt);
    assert.match(msg, /nenhum gate está aguardando decisão/, prompt);
    assert.match(msg, /está em PLANNING/, prompt);
    assert.match(msg, /team status/, prompt); // próximo passo
  }
  assert.deepEqual(listApprovals(root), []);
  assert.deepEqual(decisionEvents(root), []);
});

test('CA-08.5 sem .team ou sem work item ativo: nada registrado e stdout vazio', () => {
  const semTime = tmpProject();
  const semWork = initProject(); // .team existe, nenhum work item
  for (const cwd of [semTime, semWork]) {
    for (const prompt of ['APROVAR', 'APROVAR G9', 'REPROVAR']) {
      const res = run('prompt-approval.mjs', { cwd, prompt });
      assert.equal(res.status, 0, `${cwd} ${prompt}`);
      assert.equal(res.stdout, '', `${cwd} ${prompt}`);
    }
  }
  assert.equal(fs.existsSync(path.join(semTime, '.team')), false); // o hook não cria nada
  assert.deepEqual(fs.readdirSync(path.join(semWork, '.team', 'approvals')), []);
  assert.deepEqual(decisionEvents(semWork), []);
});

test('CA-08.6 as frases da conversa não emitem nada no hook', () => {
  const root = startedProject();
  core.moveTo(root, 'WAITING_G1_APPROVAL');
  for (const prompt of [
    'precisamos aprovar isso amanhã',
    'o cliente aprovou o orçamento',
    'vamos revisar antes de aprovar',
    'acho que dá pra APROVAR G1',
    'ok, pode seguir',
  ]) {
    const res = run('prompt-approval.mjs', { cwd: root, prompt });
    assert.equal(res.status, 0, prompt);
    assert.equal(res.stdout, '', prompt);
  }
  assert.deepEqual(listApprovals(root), []);
  assert.deepEqual(decisionEvents(root), []);
});

test('CA-08.7 nenhum cenário da US-08 cria arquivo em approvals/ nem evento de decisão no log', () => {
  const root = startedProject();
  const logFile = path.join(root, '.team', 'logs', 'orchestration.jsonl');
  const prompts = ['APROVAR', 'APROVADO', 'APROVAR G9', 'APROVAR GX', 'APROVAR G0', 'REPROVAR', 'REJEITO', 'REPROVAR G9 x',
    'precisamos aprovar isso amanhã', 'ok, pode seguir'];
  for (const status of [null, 'WAITING_G1_APPROVAL']) {
    if (status) core.moveTo(root, status);
    const logAntes = fs.readFileSync(logFile, 'utf8');
    for (const prompt of prompts) run('prompt-approval.mjs', { cwd: root, prompt });
    assert.equal(fs.readFileSync(logFile, 'utf8'), logAntes, String(status)); // log intacto, byte a byte
    assert.deepEqual(listApprovals(root), [], String(status));
  }
  assert.equal(core.checkApproval(root, core.loadState(root), 'G1').valid, false);
  // controle: a decisão completa continua gravando (o teste acima não passa por acaso)
  run('prompt-approval.mjs', { cwd: root, prompt: 'APROVAR G1' });
  assert.deepEqual(listApprovals(root), ['G1.json']);
  assert.equal(decisionEvents(root).length, 1);
});

test('CA-08.8 decisão incompleta seguida da completa: só a completa registra', () => {
  const root = startedProject();
  core.moveTo(root, 'WAITING_G1_APPROVAL');
  assertIncompleteWarning(run('prompt-approval.mjs', { cwd: root, prompt: 'APROVAR' }), 'APROVAR');
  const res = run('prompt-approval.mjs', { cwd: root, prompt: 'APROVAR G1' });
  assert.match(context(res), /APROVOU G1/);
  core.moveTo(root, 'ARCHITECTING');
});
