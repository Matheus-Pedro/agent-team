// RNF-07 / ADR-007 — migração v1.0 → v1.1.
//
// O W-001 troca de runtime no meio do fluxo: o `.team/` foi escrito pela v1.0 e
// passa a ser lido pela v1.1 depois da reinstalação (a chave de assinatura é a
// mesma, porque fica em ~/.claude/team e o instalador não a recria).
//
// Dois testes, com fontes diferentes de "dado v1.0":
//   1. o `.team/` é produzido pelo **próprio código da v1.0** (core.mjs do commit
//      86c79f9, extraído do histórico do git para um diretório temporário);
//   2. um fixture **congelado** no formato v1.0, escrito à mão, que continua valendo
//      mesmo se o histórico do git não estiver disponível (clone raso, tarball).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { core, rules, tmpProject, REPO } from './helpers.mjs';

const V10_COMMIT = '86c79f9'; // "chore: agent-team v0.1.0" = runtime v1.0 instalado antes do W-001
const CLI = path.join(REPO, 'runtime', 'bin', 'team.mjs');
const PROMPT_HOOK = path.join(REPO, 'runtime', 'hooks', 'prompt-approval.mjs');
const GUARD_HOOK = path.join(REPO, 'runtime', 'hooks', 'guard.mjs');

const cli = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: process.env });
const prompt = (cwd, text) =>
  spawnSync(process.execPath, [PROMPT_HOOK], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd, prompt: text }),
    encoding: 'utf8',
    env: process.env,
  });
const guard = (cwd, command) =>
  spawnSync(process.execPath, [GUARD_HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: process.env,
  });

/** Repositório git real com commit base, na branch do work item (a v1.0 também exigia git real
    para decidir a branch; um `.git/` vazio vira branch indeterminada na v1.1, CA-01.2). */
function gitRepo() {
  const dir = tmpProject();
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git('config', 'user.email', 'qa@example.invalid');
  git('config', 'user.name', 'qa-migration');
  fs.writeFileSync(path.join(dir, 'README.md'), '# projeto temporário\n');
  git('add', '.');
  git('commit', '-m', 'commit base');
  git('checkout', '-b', 'team/w-001-evolucao-v1-1');
  return dir;
}

const nextMs = () => {
  const t = Date.now();
  while (Date.now() === t) { /* decided_at tem precisão de ms */ }
};

/** core.mjs da v1.0, extraído do histórico, ou null se o commit não estiver disponível. */
function loadV10Source() {
  try {
    return execFileSync('git', ['-C', REPO, 'show', `${V10_COMMIT}:runtime/lib/core.mjs`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** A partir daqui só a v1.1 toca o projeto: CLI, hooks e core atuais. */
function continueWithV11(root, workId) {
  // leitura sem erro: estado, config e aprovações
  const state = core.loadState(root);
  assert.equal(state.version, 1);
  assert.equal(state.work.id, workId);
  assert.doesNotThrow(() => core.loadConfig(root));

  const status = cli(root, 'status', '--json');
  assert.equal(status.status, 0, status.stderr);
  const json = JSON.parse(status.stdout);
  assert.equal(json.status ?? json.state?.status, 'TESTING', status.stdout);

  // TESTING → REVIEWING → WAITING_G3_APPROVAL: gates seguintes funcionam
  assert.equal(cli(root, 'move', 'REVIEWING').status, 0);
  assert.equal(cli(root, 'move', 'WAITING_G3_APPROVAL').status, 0);
  const semG3 = cli(root, 'move', 'MERGING');
  assert.equal(semG3.status, 3, 'sem G3 a v1.1 recusa com o código de aprovação');

  // decisão incompleta (US-08) sobre dado v1.0: aviso, nada gravado
  const incompleta = prompt(root, 'APROVAR');
  assert.match(JSON.parse(incompleta.stdout).hookSpecificOutput.additionalContext, /APROVAR G3/);
  assert.equal(fs.existsSync(core.approvalFile(root, workId, 'G3')), false);

  const g3 = prompt(root, 'APROVAR G3');
  assert.match(JSON.parse(g3.stdout).hookSpecificOutput.additionalContext, /APROVOU G3/);
  assert.equal(guard(root, 'gh pr merge 1 --squash').status, 2, 'ainda em WAITING_G3');
  assert.equal(cli(root, 'move', 'MERGING').status, 0);
  const merge = guard(root, 'gh pr merge 1 --squash');
  assert.equal(merge.status, 0, `MERGING + G3 da v1.1 libera o merge: ${merge.stderr}`);

  // G1 e G2 assinados pela v1.0 continuam válidos depois de tudo isso
  const final = core.loadState(root);
  assert.equal(core.checkApproval(root, final, 'G1').valid, true);
  assert.equal(core.checkApproval(root, final, 'G2').valid, true);
}

test('RNF-07 .team/ escrito pelo runtime v1.0 real continua operável na v1.1', async (t) => {
  const src = loadV10Source();
  if (!src) {
    t.skip(`commit ${V10_COMMIT} indisponível no histórico; o fixture congelado abaixo cobre o formato`);
    return;
  }
  // A v1.0 só importa módulos nativos: basta um arquivo solto. Ela lê AGENT_TEAM_HOME
  // no import, que helpers.mjs já apontou para o TEAM_HOME temporário deste processo —
  // a mesma chave que a v1.1 vai usar, como numa reinstalação.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-v10-'));
  const file = path.join(dir, 'core-v1.0.mjs');
  fs.writeFileSync(file, src);
  const v10 = await import(pathToFileURL(file).href);
  assert.equal(v10.KEY_FILE, core.KEY_FILE, 'v1.0 e v1.1 compartilham a chave (reinstalação)');
  assert.equal(typeof v10.rejectionFile, 'undefined', 'é mesmo o código da v1.0');

  const root = gitRepo();
  v10.initTeam(root);
  v10.startWork(root, { slug: 'evolucao-v1-1', title: 'Evolucao do agent-team via dogfooding', track: 'G' });
  const workId = 'W-001-evolucao-v1-1';
  v10.addTask(root, { id: 'T1', agent: 'product', title: 'Requisitos' });
  v10.moveTo(root, 'WAITING_G1_APPROVAL');
  // G1: reprovado e depois aprovado, tudo pela v1.0 (os dois arquivos ficam em disco)
  v10.recordDecision(root, { gate: 'G1', decision: 'rejected', note: 'faltou a US-08' });
  nextMs();
  v10.recordDecision(root, { gate: 'G1', decision: 'approved' });
  v10.moveTo(root, 'ARCHITECTING');
  v10.moveTo(root, 'WAITING_G2_APPROVAL');
  v10.recordDecision(root, { gate: 'G2', decision: 'approved' });
  v10.moveTo(root, 'IMPLEMENTING');
  v10.moveTo(root, 'TESTING');

  // a reprovação antiga da v1.0 não derruba a aprovação posterior (ADR-004, dado legado)
  assert.ok(fs.existsSync(core.rejectionFile(root, workId, 'G1')));
  const lidos = core.loadState(root);
  assert.deepEqual(
    ['G1', 'G2'].map((g) => core.checkApproval(root, lidos, g).valid),
    [true, true],
  );

  // config da v1.0 preservada como está: a v1.1 não reescreve nem "migra" (ADR-007)
  const cfgAntes = fs.readFileSync(path.join(root, '.team', 'config.json'), 'utf8');
  continueWithV11(root, workId);
  assert.equal(fs.readFileSync(path.join(root, '.team', 'config.json'), 'utf8'), cfgAntes);
  assert.equal(core.loadConfig(root).gates.P.G1, true, 'trilha P da v1.0 continua como o usuário a tinha');

  // log de auditoria: eventos da v1.0 preservados e os da v1.1 anexados, com actor user nas decisões
  const log = fs.readFileSync(path.join(root, '.team', 'logs', 'orchestration.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const decisoes = log.filter((e) => e.event === 'approved' || e.event === 'rejected').map((e) => `${e.event}:${e.gate}:${e.actor}`);
  assert.deepEqual(decisoes, ['rejected:G1:user', 'approved:G1:user', 'approved:G2:user', 'approved:G3:user']);
});

test('RNF-07 retrabalho feito na v1.0 (revogação) é respeitado pela v1.1 e o gate volta a funcionar', async (t) => {
  const src = loadV10Source();
  if (!src) {
    t.skip(`commit ${V10_COMMIT} indisponível no histórico`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-v10-'));
  const file = path.join(dir, 'core-v1.0.mjs');
  fs.writeFileSync(file, src);
  const v10 = await import(pathToFileURL(file).href);

  const root = gitRepo();
  v10.initTeam(root);
  v10.startWork(root, { slug: 'estoque', title: 'Estoque', track: 'G' });
  v10.moveTo(root, 'WAITING_G1_APPROVAL');
  v10.recordDecision(root, { gate: 'G1', decision: 'approved' });
  v10.moveTo(root, 'ARCHITECTING');
  v10.moveTo(root, 'WAITING_G2_APPROVAL');
  v10.recordDecision(root, { gate: 'G2', decision: 'approved' });
  v10.moveTo(root, 'IMPLEMENTING');
  nextMs();
  v10.moveTo(root, 'ARCHITECTING', { reason: 'retrabalho' }); // v1.0 revoga G2

  const st = core.loadState(root);
  assert.equal(core.checkApproval(root, st, 'G1').valid, true);
  assert.match(core.checkApproval(root, st, 'G2').reason, /revogado por retrabalho/);

  assert.equal(cli(root, 'move', 'WAITING_G2_APPROVAL').status, 0);
  assert.equal(cli(root, 'move', 'IMPLEMENTING').status, 3, 'G2 revogado pela v1.0 não vale na v1.1');
  nextMs();
  assert.match(JSON.parse(prompt(root, 'APROVAR G2').stdout).hookSpecificOutput.additionalContext, /APROVOU G2/);
  assert.equal(cli(root, 'move', 'IMPLEMENTING').status, 0);
});

// ---------------------------------------------------------------- fixture congelado v1.0

/** Assinatura no formato da v1.0 (core.mjs@86c79f9, `signable`). Congelada aqui de propósito:
    se a v1.1 mudar a fórmula, este teste quebra (ADR-007 exige compatibilidade). O valor da
    chave só existe em memória; nunca é impresso nem gravado fora do TEAM_HOME temporário. */
function signV10(rec) {
  const key = core.loadOrCreateKey();
  const payload = JSON.stringify([rec.work_id, rec.gate, rec.decision, rec.decided_at, rec.state_at_decision, rec.actor]);
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

function writeFrozenV10Team(root) {
  const team = path.join(root, '.team');
  for (const sub of ['approvals/W-001-evolucao-v1-1', 'logs', 'work/W-001-evolucao-v1-1']) {
    fs.mkdirSync(path.join(team, sub), { recursive: true });
  }
  // config.json da v1.0: trilha P com todos os gates e sem os padrões do instalador
  const config = {
    version: 1,
    enforce: true,
    main_branches: ['main', 'master'],
    max_rework_attempts: 2,
    gates: {
      P: { G1: true, G2: true, G3: true, G4: true },
      M: { G1: true, G2: true, G3: true, G4: true },
      G: { G1: true, G2: true, G3: true, G4: true },
    },
    deploy: {
      patterns: [String.raw`\bkubectl\s+(apply|rollout|set\s+image)`, String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?deploy\b`],
      production_patterns: [String.raw`--prod\b`, String.raw`\bprod(uction)?\b`, String.raw`\bprd\b`],
    },
  };
  fs.writeFileSync(path.join(team, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  // state.json da v1.0, com a forma do W-001 real (tarefas, histórico, revocations vazio)
  const h = (from, to, at, reason) => ({ from, to, at, ...(reason ? { reason } : {}) });
  const state = {
    version: 1,
    project: 'agent-team',
    status: 'TESTING',
    work: {
      id: 'W-001-evolucao-v1-1',
      slug: 'evolucao-v1-1',
      title: 'Evolucao do agent-team via dogfooding',
      track: 'G',
      branch: 'team/w-001-evolucao-v1-1',
      started_at: '2026-09-17T02:56:35.077Z',
      status_history: [
        h('IDLE', 'PLANNING', '2026-09-17T02:56:35.077Z'),
        h('PLANNING', 'WAITING_G1_APPROVAL', '2026-09-17T03:06:11.302Z', 'requisitos prontos'),
        h('WAITING_G1_APPROVAL', 'ARCHITECTING', '2026-09-17T21:31:12.387Z', 'G1 aprovado'),
        h('ARCHITECTING', 'WAITING_G2_APPROVAL', '2026-09-17T21:52:49.750Z'),
        h('WAITING_G2_APPROVAL', 'IMPLEMENTING', '2026-09-17T22:02:48.708Z', 'G2 aprovado'),
        h('IMPLEMENTING', 'TESTING', '2026-09-17T22:32:33.274Z'),
      ],
      revocations: {},
      tasks: {
        T1: { agent: 'product', title: 'Requisitos', deps: [], files: 'docs/requirements/**', status: 'done', attempts: 0 },
        TT: { agent: 'qa-engineer', title: 'Testes', deps: ['T1'], files: 'tests/**', status: 'pending', attempts: 0 },
      },
    },
    history: [],
  };
  fs.writeFileSync(path.join(team, 'state.json'), JSON.stringify(state, null, 2) + '\n');

  const decision = (gate, decided_at, state_at_decision, note = '') => {
    const rec = { work_id: 'W-001-evolucao-v1-1', gate, decision: 'approved', decided_at, state_at_decision, actor: 'user', note };
    rec.signature = signV10(rec);
    fs.writeFileSync(path.join(team, 'approvals', 'W-001-evolucao-v1-1', `${gate}.json`), JSON.stringify(rec, null, 2) + '\n');
  };
  decision('G1', '2026-09-17T21:30:58.120Z', 'WAITING_G1_APPROVAL', 'considere multi-empresa na v2');
  decision('G2', '2026-09-17T22:02:30.001Z', 'WAITING_G2_APPROVAL');
  fs.writeFileSync(
    path.join(team, 'logs', 'orchestration.jsonl'),
    [
      { ts: '2026-09-17T02:50:00.000Z', actor: 'orchestrator', event: 'team_initialized' },
      { ts: '2026-09-17T21:30:58.120Z', actor: 'user', event: 'approved', gate: 'G1', work: 'W-001-evolucao-v1-1' },
      { ts: '2026-09-17T22:02:30.001Z', actor: 'user', event: 'approved', gate: 'G2', work: 'W-001-evolucao-v1-1' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

test('RNF-07 fixture congelado no formato v1.0: a v1.1 lê, valida as aprovações e continua o fluxo', () => {
  const root = gitRepo();
  writeFrozenV10Team(root);
  const workId = 'W-001-evolucao-v1-1';

  // aprovação adulterada no mesmo formato continua inválida (controle: a validação é real)
  const st = core.loadState(root);
  assert.equal(core.checkApproval(root, st, 'G1').valid, true);
  const g2File = core.approvalFile(root, workId, 'G2');
  const original = fs.readFileSync(g2File, 'utf8');
  fs.writeFileSync(g2File, original.replace('22:02:30.001Z', '22:02:30.002Z'));
  assert.match(core.checkApproval(root, st, 'G2').reason, /assinatura inválida/);
  fs.writeFileSync(g2File, original);
  assert.equal(core.checkApproval(root, st, 'G2').valid, true);

  // o guard da v1.1 aplica a config da v1.0 sem erro
  assert.equal(rules.evaluateToolCall({ tool_name: 'Bash', tool_input: { command: 'npm run deploy' }, cwd: root }).deny, true);
  assert.equal(rules.evaluateToolCall({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: root }).deny, false);

  continueWithV11(root, workId);
});
