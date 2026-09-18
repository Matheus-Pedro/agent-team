import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { core, initProject, tmpProject, startedProject, driveTo, editConfig, REPO } from './helpers.mjs';
import { missingBaseCommitMessage } from '../runtime/lib/git.mjs';

const { moveTo, recordDecision, loadState, checkApproval, startWork, addTask, setTask, readyTasks } = core;

const throwsCode = (fn, code, re) =>
  assert.throws(fn, (e) => e instanceof core.TeamError && e.exitCode === code && (!re || re.test(e.message)));

/** Espera a virada do milissegundo, para que duas decisões tenham `decided_at` distintos. */
function tick() {
  const t0 = Date.now();
  while (Date.now() <= t0) { /* espera ativa de ~1 ms */ }
}

/** Fixa `new Date()` e `Date.now()` em `iso` enquanto `fn` roda (para testar empate de timestamp). */
function withFixedClock(iso, fn) {
  const Real = Date;
  const ms = Real.parse(iso);
  class FixedDate extends Real {
    constructor(...args) {
      super(...(args.length ? args : [ms]));
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = FixedDate;
  try {
    return fn();
  } finally {
    globalThis.Date = Real;
  }
}

const CLI = path.join(REPO, 'runtime', 'bin', 'team.mjs');

/**
 * Executa o CLI em processo filho, sempre contra projeto temporário e o
 * `AGENT_TEAM_HOME` temporário de `helpers.mjs` (regra de dogfooding do RNF-09).
 */
const teamCli = (cwd, ...args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: process.env });

/** Projeto temporário com repositório git real (sem `.git` falso). */
function gitProject({ branch = 'main', commit = false } = {}) {
  const dir = tmpProject();
  const git = (...args) => execFileSync('git', args, { stdio: 'ignore', timeout: 20000 });
  git('init', '--quiet', dir);
  git('-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  if (commit) {
    git('-C', dir, '-c', 'user.name=teste', '-c', 'user.email=teste@exemplo.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'commit base');
  }
  return dir;
}

/** Espelha `detectDeploy` de guard-rules.mjs (normaliza `\` e usa flag `i`). */
function classifyDeploy(command, deploy = core.defaultConfig().deploy) {
  const n = String(command).replace(/\\/g, '/');
  const test = (list) => (list || []).some((p) => new RegExp(p, 'i').test(n));
  if (!test(deploy.patterns)) return null;
  return { production: test(deploy.production_patterns) };
}

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

// ---------- US-02: instalar/desinstalar é deploy (ADR-002) ----------

const NEW_DEPLOY_PATTERNS = [
  String.raw`\b(un)?install:claude\b`,
  String.raw`\bnode(\.exe)?\s+\S*scripts/(un)?install\.mjs`,
];
const NEW_PRODUCTION_PATTERN =
  String.raw`^(?!.*--claude-dir).*(\b(un)?install:claude\b|\bnode(\.exe)?\s+\S*scripts/(un)?install\.mjs)`;

test('CA-02.6 / CA-06.1 projeto novo nasce protegido e com a trilha P mais leve, sem edição manual', () => {
  const cfg = core.defaultConfig();
  assert.deepEqual(cfg.gates, {
    P: { G1: false, G2: false, G3: true, G4: true },
    M: { G1: true, G2: true, G3: true, G4: true },
    G: { G1: true, G2: true, G3: true, G4: true },
  });
  for (const p of NEW_DEPLOY_PATTERNS) assert.ok(cfg.deploy.patterns.includes(p), p);
  assert.ok(cfg.deploy.production_patterns.includes(NEW_PRODUCTION_PATTERN));

  // o que `team init` grava em disco é exatamente o default (CA-02.6, CA-06.1)
  const root = initProject();
  const written = JSON.parse(fs.readFileSync(path.join(root, '.team', 'config.json'), 'utf8'));
  assert.deepEqual(written.gates, cfg.gates);
  assert.deepEqual(written.deploy, cfg.deploy);
  assert.equal(written.version, 1); // ADR-007: formato congelado
});

test('CA-02.1 a CA-02.4 os padrões novos classificam instalador e desinstalador', () => {
  for (const cmd of [
    'npm run install:claude',
    'npm run uninstall:claude',
    'node scripts/install.mjs',
    'node scripts/uninstall.mjs',
    'node.exe scripts\\install.mjs', // contrabarra (PowerShell)
    'NPM RUN INSTALL:CLAUDE', // caixa alta
  ]) {
    assert.deepEqual(classifyDeploy(cmd), { production: true }, cmd);
  }
  // com --claude-dir é deploy não produtivo (CA-02.2)
  assert.deepEqual(classifyDeploy('node scripts/install.mjs --claude-dir /tmp/x'), { production: false });
  assert.deepEqual(classifyDeploy('npm run install:claude -- --claude-dir C:\\tmp\\x'), { production: false });
  // não é deploy (CA-02.4 e regressões)
  for (const cmd of ['npm test', 'git add scripts/install.mjs', 'git diff scripts/uninstall.mjs', 'node --version']) {
    assert.equal(classifyDeploy(cmd), null, cmd);
  }
  // ADR-010: o padrão do dogfooding (runtime/bin/team.mjs) fica só na config deste
  // repositório e NÃO entra no default — em outro projeto não significa nada.
  assert.equal(classifyDeploy('node runtime/bin/team.mjs status'), null);
});

test('CA-06.2 config já existente continua como está depois do runtime novo', () => {
  const root = initProject();
  const v10 = {
    version: 1,
    enforce: true,
    main_branches: ['main', 'master'],
    max_rework_attempts: 2,
    gates: {
      P: { G1: true, G2: true, G3: true, G4: true },
      M: { G1: true, G2: true, G3: true, G4: true },
      G: { G1: true, G2: true, G3: true, G4: true },
    },
    deploy: { patterns: [String.raw`\bmeu-deploy\b`], production_patterns: [String.raw`\bprod\b`] },
  };
  fs.writeFileSync(path.join(root, '.team', 'config.json'), JSON.stringify(v10, null, 2));
  const cfg = core.loadConfig(root);
  assert.deepEqual(cfg.deploy, v10.deploy); // os arrays do usuário substituem o default (ADR-007, regra 6)
  assert.deepEqual(cfg.gates, v10.gates);
  assert.equal(classifyDeploy('npm run install:claude', cfg.deploy), null);
  assert.equal(core.gateEnabled(cfg, 'P', 'G1'), true);
});

test('trilha P padrão vai de PLANNING a IMPLEMENTING sem G1 e G2; G3 e PROD continuam (CA-06.4)', () => {
  const root = initProject();
  startWork(root, { slug: 'bug-123', track: 'P' });
  moveTo(root, 'ARCHITECTING'); // G1 desligado no default
  moveTo(root, 'IMPLEMENTING'); // G2 desligado no default
  moveTo(root, 'TESTING');
  moveTo(root, 'REVIEWING');
  throwsCode(() => moveTo(root, 'MERGING'), 1); // G3 continua ligado
  moveTo(root, 'WAITING_G3_APPROVAL');
  recordDecision(root, { gate: 'G3', decision: 'approved' });
  moveTo(root, 'MERGING');
  moveTo(root, 'MERGED');
  moveTo(root, 'PREPARING_DEPLOY');
  // G4 continua ligado: a transição direta para DEPLOYING nem existe
  throwsCode(() => moveTo(root, 'DEPLOYING'), 1, /WAITING_G4_APPROVAL/);
  moveTo(root, 'WAITING_G4_APPROVAL');
  recordDecision(root, { gate: 'G4', decision: 'approved' });
  moveTo(root, 'DEPLOYING');
  moveTo(root, 'WAITING_PROD_APPROVAL');
  throwsCode(() => moveTo(root, 'DEPLOYING_PROD'), 3, /PROD/);
});

// ---------- US-04: a última decisão do usuário prevalece (ADR-004) ----------

test('CA-04.1 reprovar depois de aprovar tira a validade da aprovação', () => {
  const root = startedProject();
  moveTo(root, 'WAITING_G1_APPROVAL');
  recordDecision(root, { gate: 'G1', decision: 'approved' });
  assert.equal(checkApproval(root, loadState(root), 'G1').valid, true);
  tick();
  recordDecision(root, { gate: 'G1', decision: 'rejected', note: 'faltou RNF de performance' });
  const chk = checkApproval(root, loadState(root), 'G1');
  assert.equal(chk.valid, false);
  assert.match(chk.reason, /reprovado pelo usuário em .*depois da aprovação/);
  throwsCode(() => moveTo(root, 'ARCHITECTING'), 3);
  // CA-04.3: os dois arquivos continuam em disco, com os nomes da v1.0
  const workId = loadState(root).work.id;
  assert.ok(fs.existsSync(core.approvalFile(root, workId, 'G1')));
  assert.ok(fs.existsSync(core.rejectionFile(root, workId, 'G1')));
});

test('CA-04.2 aprovar depois de reprovar volta a valer e libera a transição', () => {
  const root = startedProject();
  moveTo(root, 'WAITING_G1_APPROVAL');
  recordDecision(root, { gate: 'G1', decision: 'rejected', note: 'faltou escopo' });
  assert.equal(checkApproval(root, loadState(root), 'G1').valid, false);
  tick();
  recordDecision(root, { gate: 'G1', decision: 'approved' });
  assert.equal(checkApproval(root, loadState(root), 'G1').valid, true);
  moveTo(root, 'ARCHITECTING');
  assert.equal(loadState(root).status, 'ARCHITECTING');
});

test('CA-04.3 o log guarda todas as decisões do gate, em ordem, com actor user', () => {
  const root = startedProject();
  moveTo(root, 'WAITING_G1_APPROVAL');
  recordDecision(root, { gate: 'G1', decision: 'approved' });
  tick();
  recordDecision(root, { gate: 'G1', decision: 'rejected', note: 'voltei atrás' });
  tick();
  recordDecision(root, { gate: 'G1', decision: 'approved' });
  const decisions = fs.readFileSync(path.join(root, '.team', 'logs', 'orchestration.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l))
    .filter((l) => ['approved', 'rejected'].includes(l.event) && l.gate === 'G1');
  assert.deepEqual(decisions.map((d) => d.event), ['approved', 'rejected', 'approved']);
  assert.deepEqual([...new Set(decisions.map((d) => d.actor))], ['user']);
  assert.equal(decisions[1].note, 'voltei atrás');
});

test('empate de decided_at: a reprovação prevalece (ADR-004)', () => {
  const root = startedProject();
  moveTo(root, 'WAITING_G1_APPROVAL');
  withFixedClock('2026-09-17T12:00:00.000Z', () => {
    recordDecision(root, { gate: 'G1', decision: 'approved' });
    recordDecision(root, { gate: 'G1', decision: 'rejected', note: 'mesmo milissegundo' });
  });
  const workId = loadState(root).work.id;
  const approval = JSON.parse(fs.readFileSync(core.approvalFile(root, workId, 'G1'), 'utf8'));
  const rejection = JSON.parse(fs.readFileSync(core.rejectionFile(root, workId, 'G1'), 'utf8'));
  assert.equal(approval.decided_at, rejection.decided_at);
  assert.equal(checkApproval(root, loadState(root), 'G1').valid, false);
  throwsCode(() => moveTo(root, 'ARCHITECTING'), 3);
});

test('reprovação forjada ou adulterada não aprova nem passa batido (fail-closed)', () => {
  const root = startedProject();
  driveTo(root, 'ARCHITECTING'); // G1 aprovado e válido
  const workId = loadState(root).work.id;
  const file = core.rejectionFile(root, workId, 'G1');
  const forged = {
    work_id: workId, gate: 'G1', decision: 'rejected', actor: 'user',
    decided_at: new Date().toISOString(), state_at_decision: 'WAITING_G1_APPROVAL', signature: 'f'.repeat(64),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(forged));
  const chk = checkApproval(root, loadState(root), 'G1');
  assert.equal(chk.valid, false);
  assert.match(chk.reason, /reprovação de G1 inconsistente/);

  // reprovação legítima de outro work item também é inconsistente aqui
  fs.writeFileSync(file, JSON.stringify({ ...forged, work_id: 'W-999-outro' }));
  assert.equal(checkApproval(root, loadState(root), 'G1').valid, false);
});

test('reprovação anterior à aprovação (dado legado da v1.0) não invalida o gate', () => {
  const root = startedProject();
  moveTo(root, 'WAITING_G1_APPROVAL');
  recordDecision(root, { gate: 'G1', decision: 'rejected', note: 'primeira rodada' });
  tick();
  recordDecision(root, { gate: 'G1', decision: 'approved' });
  tick();
  moveTo(root, 'ARCHITECTING');
  // retrabalho continua revogando, e a reprovação antiga não muda a razão
  const r = moveTo(root, 'PLANNING', { reason: 'mudou o escopo' });
  assert.ok(r.revoked.includes('G1'));
  assert.match(checkApproval(root, loadState(root), 'G1').reason, /revogado por retrabalho/);
});

// ---------- US-01 (CLI) e CA-06.3: avisos de git e gates por trilha ----------

test('CA-01.3 / CA-01.4 / CA-06.3 o CLI avisa do commit base e lista os gates por trilha', () => {
  const root = gitProject({ branch: 'main' });
  const init = teamCli(root, 'init');
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /^Gates por trilha: P → G3, G4, PROD \| M → G1\.\.G4, PROD \| G → G1\.\.G4, PROD$/m);
  // o texto do aviso é de git.mjs (contrato §1): o CLI só o repassa, prefixado por ⚠️
  const aviso = `⚠️ ${missingBaseCommitMessage('main')}`;
  assert.ok(init.stdout.split('\n').includes(aviso), init.stdout);

  const txt = teamCli(root, 'status');
  assert.equal(txt.status, 0, txt.stderr);
  const lines = txt.stdout.trim().split('\n');
  assert.match(lines[1], /^Estado:/);
  assert.equal(lines[2], aviso); // logo depois da linha "Estado:" (CA-01.3)

  const json = JSON.parse(teamCli(root, 'status', '--json').stdout);
  assert.equal(json.git.repo, true);
  assert.equal(json.git.branch, 'main');
  assert.equal(json.git.branch_kind, 'branch');
  assert.equal(json.git.has_base_commit, false);
  assert.equal(json.git.warnings.length, 1);
  assert.match(json.git.warnings[0], /commit base em main/);
});

test('CA-01.5 com commit base na principal o CLI não avisa nada', () => {
  const root = gitProject({ branch: 'main', commit: true });
  assert.doesNotMatch(teamCli(root, 'init').stdout, /⚠️/);
  const json = JSON.parse(teamCli(root, 'status', '--json').stdout);
  assert.deepEqual(json.git, {
    repo: true, branch: 'main', branch_kind: 'branch', has_base_commit: true, warnings: [],
  });
});

test('CA-01.6 sem git: nenhum aviso e nenhuma falha em init e status', () => {
  const root = tmpProject();
  const init = teamCli(root, 'init');
  assert.equal(init.status, 0, init.stderr);
  assert.doesNotMatch(init.stdout, /⚠️/);
  const txt = teamCli(root, 'status');
  assert.equal(txt.status, 0, txt.stderr);
  assert.doesNotMatch(txt.stdout, /⚠️/);
  const json = JSON.parse(teamCli(root, 'status', '--json').stdout);
  assert.deepEqual(json.git, {
    repo: false, branch: null, branch_kind: 'no-repo', has_base_commit: null, warnings: [],
  });
});

test('CA-04.4 status --json mostra o gate como não aprovado depois da reprovação', () => {
  const root = startedProject();
  moveTo(root, 'WAITING_G1_APPROVAL');
  recordDecision(root, { gate: 'G1', decision: 'approved' });
  tick();
  const json1 = JSON.parse(teamCli(root, 'status', '--json').stdout);
  assert.equal(json1.gates.G1.approved, true);
  recordDecision(root, { gate: 'G1', decision: 'rejected', note: 'voltei atrás' });
  const json2 = JSON.parse(teamCli(root, 'status', '--json').stdout);
  assert.equal(json2.gates.G1.approved, false);
  assert.equal(json2.transitions.find((t) => t.to === 'ARCHITECTING').allowed, false);
  assert.match(teamCli(root, 'status').stdout, /requer G1 — BLOQUEADO/);
});
