import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { core, initProject, tmpProject, startedProject, driveTo, editConfig } from './helpers.mjs';

const { moveTo, recordDecision, loadState, checkApproval, startWork, addTask, setTask, readyTasks } = core;

const throwsCode = (fn, code, re) =>
  assert.throws(fn, (e) => e instanceof core.TeamError && e.exitCode === code && (!re || re.test(e.message)));

test('init cria a estrutura, ignora .team no git e não pode ser repetido', () => {
  const root = tmpProject({ git: true });
  core.initTeam(root);
  for (const f of ['config.json', 'state.json', 'approvals', 'logs', 'work']) {
    assert.ok(fs.existsSync(path.join(root, '.team', f)), f);
  }
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.team\/$/m);
  assert.equal(loadState(root).status, 'IDLE');
  throwsCode(() => core.initTeam(root), 1, /já inicializado/);
});

test('não avança de gate sem aprovação do usuário', () => {
  const root = startedProject();
  assert.equal(loadState(root).status, 'PLANNING');
  throwsCode(() => moveTo(root, 'ARCHITECTING'), 1, /Transição inválida/);
  moveTo(root, 'WAITING_G1_APPROVAL');
  throwsCode(() => moveTo(root, 'ARCHITECTING'), 3, /APROVAR G1/);
  recordDecision(root, { gate: 'G1', decision: 'approved' });
  moveTo(root, 'ARCHITECTING');
  assert.equal(loadState(root).status, 'ARCHITECTING');
});

test('decisão só é aceita quando o estado está aguardando aquele gate', () => {
  const root = startedProject();
  throwsCode(() => recordDecision(root, { gate: 'G1', decision: 'approved' }), 1, /PLANNING/);
  moveTo(root, 'WAITING_G1_APPROVAL');
  throwsCode(() => recordDecision(root, { gate: 'G2', decision: 'approved' }), 1);
});

test('reprovação não libera a transição e permite voltar para retrabalho', () => {
  const root = startedProject();
  moveTo(root, 'WAITING_G1_APPROVAL');
  recordDecision(root, { gate: 'G1', decision: 'rejected', note: 'faltou RNF de performance' });
  throwsCode(() => moveTo(root, 'ARCHITECTING'), 3);
  moveTo(root, 'PLANNING', { reason: 'G1 reprovado' });
  assert.equal(loadState(root).status, 'PLANNING');
});

test('aprovação forjada ou adulterada é rejeitada', () => {
  const root = startedProject();
  driveTo(root, 'WAITING_G1_APPROVAL');
  const file = core.approvalFile(root, loadState(root).work.id, 'G1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    work_id: loadState(root).work.id, gate: 'G1', decision: 'approved', actor: 'user',
    decided_at: new Date().toISOString(), state_at_decision: 'WAITING_G1_APPROVAL', signature: 'f'.repeat(64),
  }));
  assert.equal(checkApproval(root, loadState(root), 'G1').valid, false);
  throwsCode(() => moveTo(root, 'ARCHITECTING'), 3);

  recordDecision(root, { gate: 'G1', decision: 'approved' });
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, work_id: 'W-999-outro' }));
  assert.equal(checkApproval(root, loadState(root), 'G1').valid, false);
});

test('gate desligado na config pula a espera; PROD nunca pode ser desligado', () => {
  const root = initProject();
  editConfig(root, (c) => {
    c.gates.P = { G1: false, G2: false, G3: true, G4: false, PROD: false };
  });
  startWork(root, { slug: 'bug-123', track: 'P' });
  moveTo(root, 'ARCHITECTING');
  moveTo(root, 'IMPLEMENTING');
  moveTo(root, 'TESTING');
  moveTo(root, 'REVIEWING');
  throwsCode(() => moveTo(root, 'MERGING'), 1); // G3 continua ligado
  moveTo(root, 'WAITING_G3_APPROVAL');
  recordDecision(root, { gate: 'G3', decision: 'approved' });
  moveTo(root, 'MERGING');
  moveTo(root, 'MERGED');
  moveTo(root, 'PREPARING_DEPLOY');
  moveTo(root, 'DEPLOYING'); // G4 desligado
  moveTo(root, 'WAITING_PROD_APPROVAL');
  throwsCode(() => moveTo(root, 'DEPLOYING_PROD'), 3, /PROD/);
});

test('retrabalho revoga as aprovações posteriores ao destino', () => {
  const root = startedProject();
  driveTo(root, 'IMPLEMENTING');
  const r = moveTo(root, 'ARCHITECTING', { reason: 'arquitetura não suporta RF-07' });
  assert.deepEqual(r.revoked, ['G2']);
  const state = loadState(root);
  assert.equal(checkApproval(root, state, 'G1').valid, true);
  assert.equal(checkApproval(root, state, 'G2').valid, false);
  moveTo(root, 'WAITING_G2_APPROVAL');
  throwsCode(() => moveTo(root, 'IMPLEMENTING'), 3, /revogado/);
  recordDecision(root, { gate: 'G2', decision: 'approved' });
  moveTo(root, 'IMPLEMENTING');
});

test('fluxo completo até DONE arquiva o work item e numera o próximo', () => {
  const root = startedProject();
  driveTo(root, 'DEPLOYING_PROD');
  moveTo(root, 'DEPLOYED');
  moveTo(root, 'DONE');
  const state = loadState(root);
  assert.equal(state.status, 'DONE');
  assert.equal(state.work, null);
  assert.equal(state.history[0].id, 'W-001-estoque');
  const next = startWork(root, { slug: 'relatorios', track: 'M' });
  assert.equal(next.id, 'W-002-relatorios');
  // aprovações do work anterior não valem para o novo
  assert.equal(checkApproval(root, loadState(root), 'G1').valid, false);
});

test('não inicia dois work items ao mesmo tempo e valida trilha/slug', () => {
  const root = startedProject();
  throwsCode(() => startWork(root, { slug: 'outro', track: 'G' }), 1, /ativo/);
  const root2 = initProject();
  throwsCode(() => startWork(root2, { slug: 'x', track: 'Z' }), 1, /Trilha/);
  throwsCode(() => startWork(root2, { slug: 'Com Espaço', track: 'G' }), 1, /Slug/);
});

test('DAG: dependências, tarefas prontas e limite de retrabalho', () => {
  const root = startedProject();
  addTask(root, { id: 'T1', agent: 'architect', title: 'contrato' });
  addTask(root, { id: 'T2', agent: 'backend', title: 'api', deps: ['T1'] });
  addTask(root, { id: 'T3', agent: 'frontend', title: 'telas', deps: ['T1'] });
  addTask(root, { id: 'T4', agent: 'qa-engineer', title: 'testes', deps: ['T2', 'T3'] });
  throwsCode(() => addTask(root, { id: 'T5', agent: 'x', deps: ['T9'] }), 1, /inexistente/);

  assert.deepEqual(readyTasks(loadState(root)).map((t) => t.id), ['T1']);
  throwsCode(() => setTask(root, 'T2', 'in_progress'), 1, /T1/);
  setTask(root, 'T1', 'done');
  assert.deepEqual(readyTasks(loadState(root)).map((t) => t.id), ['T2', 'T3']); // paralelizáveis

  setTask(root, 'T2', 'done');
  setTask(root, 'T3', 'done');
  setTask(root, 'T2', 'rework', { note: 'QA achou bug no estoque negativo' });
  setTask(root, 'T2', 'done');
  setTask(root, 'T2', 'rework');
  throwsCode(() => setTask(root, 'T2', 'rework'), 4, /Limite de retrabalho/);
});

test('log de auditoria registra ator de cada evento', () => {
  const root = startedProject();
  driveTo(root, 'ARCHITECTING');
  const lines = fs.readFileSync(path.join(root, '.team', 'logs', 'orchestration.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const approved = lines.find((l) => l.event === 'approved');
  assert.equal(approved.actor, 'user');
  assert.equal(approved.gate, 'G1');
  assert.ok(lines.some((l) => l.event === 'transition' && l.to === 'ARCHITECTING' && l.actor === 'orchestrator'));
});
