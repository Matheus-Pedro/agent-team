// QA (TT) — lacunas da v1.1 cobertas no nível do hook `guard.mjs`, rodando como o
// harness roda (processo separado, JSON no stdin, git real quando importa).
// Os testes unitários das regras ficam em guard.test.mjs; aqui não se duplica o que
// já está lá, só se prova o mesmo critério pelo caminho de ponta a ponta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { rules, core, startedProject, driveTo, tmpProject, editConfig, REPO } from './helpers.mjs';

const { evaluateToolCall } = rules;
const GUARD_HOOK = path.join(REPO, 'runtime', 'hooks', 'guard.mjs');

/** Projeto com `.team/` ativo (IMPLEMENTING) e repositório git real com commit base. */
function gitProject({ branch = 'team/w-001-estoque' } = {}) {
  const dir = tmpProject();
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git('config', 'user.email', 'qa@example.invalid');
  git('config', 'user.name', 'qa-test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# projeto temporário\n');
  git('add', '.');
  git('commit', '-m', 'commit base');
  if (branch !== 'main') git('checkout', '-b', branch);
  core.initTeam(dir);
  core.startWork(dir, { slug: 'estoque', title: 'Controle de estoque', track: 'G' });
  driveTo(dir, 'IMPLEMENTING');
  return dir;
}

/** Env sem as variáveis indicadas (comparação sem caixa: no Windows é `Path`). */
const envWithout = (drop, extra = {}) => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!drop.includes(k.toUpperCase())) env[k] = v;
  return { ...env, ...extra };
};
const runHook = (payload, { env = process.env, execArgv = [] } = {}) =>
  spawnSync(process.execPath, [...execArgv, GUARD_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env });
const bashPayload = (cwd, command) => ({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } });
const bash = (root, command) => evaluateToolCall({ tool_name: 'Bash', tool_input: { command }, cwd: root });

// ---------------------------------------------------------------- US-01

test('CA-01.7 (hook, git real) HEAD destacado: commit permitido como na v1.0; alvo na principal continua bloqueado', () => {
  const root = gitProject();
  execFileSync('git', ['-C', root, 'checkout', '--detach'], { stdio: 'ignore' });
  const commit = runHook(bashPayload(root, 'git commit -m "wip"'));
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(runHook(bashPayload(root, 'git rebase outra')).status, 0);
  const push = runHook(bashPayload(root, 'git push origin main'));
  assert.equal(push.status, 2);
  assert.match(push.stderr, /^\[agent-team\] BLOQUEADO: push para a branch principal/);
});

test('CA-01.2 (hook, git real) repositório ilegível: tudo que altera histórico é bloqueado', () => {
  const root = gitProject();
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'isto não é uma referência\n');
  for (const c of ['git commit -m x', 'git merge outra', 'git rebase main', 'git push', 'git cherry-pick abc', 'git revert abc', 'git am p.diff']) {
    const res = runHook(bashPayload(root, c));
    assert.equal(res.status, 2, `${c}: ${res.stderr}`);
    assert.match(res.stderr, /^\[agent-team\] BLOQUEADO: .*não foi possível identificar a branch atual/i, c);
    assert.match(res.stderr, /usuário/, c); // próximo passo (RNF-05)
  }
  assert.equal(runHook(bashPayload(root, 'git status')).status, 0); // não altera histórico
});

test('CA-01.2 (hook) git fora do PATH: histórico bloqueado; fora de projeto com time nada muda', () => {
  const root = gitProject();
  const env = envWithout(['PATH', 'PATHEXT'], { PATH: path.join(os.tmpdir(), 'sem-git-aqui') });
  const res = runHook(bashPayload(root, 'git commit -m x'), { env });
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /não foi possível identificar a branch atual/i);
  assert.match(res.stderr, /git não encontrado no PATH/);
  // RNF-04: fora de projeto com time, nunca bloqueia
  assert.equal(runHook(bashPayload(tmpProject(), 'git commit -m x'), { env }).status, 0);
});

// ---------------------------------------------------------------- US-02 (decisão do guard por fase)
// core.test.mjs prova a classificação dos padrões; aqui, a decisão do guard em cada fase.

const INSTALADORES = [
  'npm run install:claude',
  'npm run uninstall:claude',
  'node scripts/install.mjs',
  'node scripts/uninstall.mjs',
  'node .\\scripts\\install.mjs',
];

test('CA-02.1 / CA-02.6 instalar ou desinstalar fora de DEPLOYING é bloqueado, citando o gate', () => {
  const root = startedProject(); // `team init` padrão, sem edição da config (CA-02.6)
  driveTo(root, 'IMPLEMENTING');
  for (const c of INSTALADORES) {
    const res = runHook(bashPayload(root, c));
    assert.equal(res.status, 2, c);
    assert.match(res.stderr, /^\[agent-team\] BLOQUEADO: Comando de deploy em PRODUÇÃO detectado.*APROVAR PROD/, c);
  }
  const alt = runHook(bashPayload(root, 'node scripts/install.mjs --claude-dir C:\\tmp\\smoke'));
  assert.equal(alt.status, 2);
  assert.match(alt.stderr, /gate G4/);
  assert.equal(runHook(bashPayload(root, 'npm test')).status, 0); // CA-02.4
});

test('CA-02.2 / CA-02.3 em DEPLOYING com G4: --claude-dir liberado, diretório real só com PROD', () => {
  const root = startedProject();
  driveTo(root, 'DEPLOYING');
  assert.equal(bash(root, 'node scripts/install.mjs --claude-dir C:\\tmp\\smoke').deny, false); // CA-02.2
  assert.equal(bash(root, 'npm run install:claude -- --claude-dir /tmp/smoke').deny, false);
  for (const c of INSTALADORES) assert.equal(bash(root, c).deny, true, c); // CA-02.3
  core.moveTo(root, 'WAITING_PROD_APPROVAL');
  core.recordDecision(root, { gate: 'PROD', decision: 'approved' });
  core.moveTo(root, 'DEPLOYING_PROD');
  for (const c of INSTALADORES) assert.equal(bash(root, c).deny, false, c);
});

test('CA-02.4 / CA-02.5 npm test em qualquer fase e instalador fora de projeto com time são liberados', () => {
  const root = startedProject();
  for (const fase of ['WAITING_G1_APPROVAL', 'ARCHITECTING', 'IMPLEMENTING', 'MERGING', 'PREPARING_DEPLOY']) {
    const r = startedProject();
    driveTo(r, fase);
    assert.equal(bash(r, 'npm test').deny, false, fase);
  }
  assert.equal(bash(root, 'npm test').deny, false);
  const fora = tmpProject();
  for (const c of INSTALADORES) assert.equal(runHook(bashPayload(fora, c)).status, 0, c);
});

// ---------------------------------------------------------------- US-03

test('CA-03.3 (hook, instalação padrão) Grep em ~/.claude, ~, raiz do volume e no runtime é bloqueado', () => {
  const root = startedProject();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-fakehome-'));
  // Sem AGENT_TEAM_HOME o runtime usa <home>/.claude/team, como numa instalação real.
  // O home é temporário: nada do diretório real do usuário é tocado.
  const env = envWithout(['AGENT_TEAM_HOME', 'USERPROFILE', 'HOME'], { USERPROFILE: fakeHome, HOME: fakeHome });
  const runtimeDir = path.join(fakeHome, '.claude', 'team');
  const keyFile = path.join(runtimeDir, path.basename(core.KEY_FILE));
  const alvos = [
    path.join(fakeHome, '.claude'), // ~/.claude
    fakeHome, // ~
    path.parse(fakeHome).root, // raiz do volume
    runtimeDir,
    path.join(runtimeDir, 'lib'),
    keyFile,
  ];
  for (const alvo of alvos) {
    for (const tool of ['Grep', 'Glob']) {
      const input = tool === 'Grep' ? { pattern: 'x', path: alvo } : { pattern: '**/*', path: alvo };
      const res = runHook({ hook_event_name: 'PreToolUse', cwd: root, tool_name: tool, tool_input: input }, { env });
      assert.equal(res.status, 2, `${tool} ${alvo}: ${res.stderr}`);
      assert.match(res.stderr, /^\[agent-team\] BLOQUEADO: busca cujo alvo alcança a chave de assinatura/, alvo);
      assert.match(res.stderr, /restrinja o alvo ao diretório do projeto/, alvo); // próximo passo
    }
  }
  // controles: alvo no projeto e um irmão de .claude continuam liberados, com qualquer padrão
  for (const alvo of [root, path.join(fakeHome, 'Documents')]) {
    const res = runHook(
      { hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Grep', tool_input: { pattern: path.basename(keyFile), path: alvo } },
      { env },
    );
    assert.equal(res.status, 0, `${alvo}: ${res.stderr}`);
  }
  assert.equal(fs.existsSync(keyFile), false); // o guard nunca cria nem lê a chave
});

// ---------------------------------------------------------------- US-04 (CA-04.5)

/** decided_at tem precisão de milissegundo: espera o relógio andar antes de cada decisão. */
const nextMs = () => {
  const t = Date.now();
  while (Date.now() === t) { /* espera ativa de no máximo 1 ms */ }
};
const decideAll = (root, gate, decisions) => {
  for (const d of decisions) {
    nextMs();
    core.recordDecision(root, { gate, decision: d });
  }
};
/* O runtime nunca move para a fase de um gate reprovado por último (CA-04.1, core.test.mjs).
   Para provar que o **guard** também confere a última decisão (e não só a fase), a fase é
   forçada direto no state.json do projeto temporário — como faria um estado adulterado. */
const forceStatus = (root, status) => {
  const st = core.loadState(root);
  st.status = status;
  core.saveState(root, st);
};

test('CA-04.5 guard bloqueia merge (G3) reprovado por último; controles liberam', () => {
  const reprovado = startedProject();
  driveTo(reprovado, 'WAITING_G3_APPROVAL');
  decideAll(reprovado, 'G3', ['approved', 'rejected']);
  forceStatus(reprovado, 'MERGING');
  const res = bash(reprovado, 'gh pr merge 12 --squash');
  assert.equal(res.deny, true);
  assert.match(res.reason, /G3 sem aprovação válida/);
  const hook = runHook(bashPayload(reprovado, 'gh pr merge 12 --squash'));
  assert.equal(hook.status, 2);
  assert.match(hook.stderr, /^\[agent-team\] BLOQUEADO: gh pr merge .*G3 sem aprovação válida/);

  // controles: só aprovação; e reprovação seguida de nova aprovação (CA-04.2)
  for (const decisions of [['approved'], ['approved', 'rejected', 'approved']]) {
    const root = startedProject();
    driveTo(root, 'WAITING_G3_APPROVAL');
    decideAll(root, 'G3', decisions);
    forceStatus(root, 'MERGING');
    assert.equal(bash(root, 'gh pr merge 12 --squash').deny, false, decisions.join(','));
  }
});

test('CA-04.5 guard bloqueia deploy (G4) e produção (PROD) reprovados por último', () => {
  const g4 = startedProject();
  driveTo(g4, 'PREPARING_DEPLOY');
  core.moveTo(g4, 'WAITING_G4_APPROVAL');
  decideAll(g4, 'G4', ['approved', 'rejected']);
  forceStatus(g4, 'DEPLOYING');
  const r4 = bash(g4, 'kubectl apply -f k8s/staging');
  assert.equal(r4.deny, true);
  assert.match(r4.reason, /G4 sem aprovação válida/);
  assert.equal(runHook(bashPayload(g4, 'kubectl apply -f k8s/staging')).status, 2);

  const prod = startedProject();
  driveTo(prod, 'WAITING_PROD_APPROVAL');
  decideAll(prod, 'PROD', ['approved', 'rejected']);
  forceStatus(prod, 'DEPLOYING_PROD');
  const rp = bash(prod, 'vercel --prod');
  assert.equal(rp.deny, true);
  assert.match(rp.reason, /PROD sem aprovação válida/);

  // controle: a mesma sequência terminando em aprovação libera
  const ok = startedProject();
  driveTo(ok, 'WAITING_PROD_APPROVAL');
  decideAll(ok, 'PROD', ['approved', 'rejected', 'approved']);
  forceStatus(ok, 'DEPLOYING_PROD');
  assert.equal(bash(ok, 'vercel --prod').deny, false);
});

// ---------------------------------------------------------------- US-05 (CA-05.1 com outro gatilho)

/* Gatilho independente da config (o de guard.test.mjs corrompe `main_branches`): um módulo
   `--import` escrito pelo teste faz `crypto.createHmac` lançar. Nenhuma linha do runtime muda;
   o erro nasce dentro de checkApproval, no meio da avaliação, como um bug real. */
function brokenCryptoArgs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-fault-'));
  const file = path.join(dir, 'hmac-quebrado.mjs');
  fs.writeFileSync(file,
    "import crypto from 'node:crypto';\n" +
    "import { syncBuiltinESMExports } from 'node:module';\n" +
    "crypto.createHmac = () => { throw new Error('falha injetada pelo teste'); };\n" +
    'syncBuiltinESMExports();\n');
  return ['--import', pathToFileURL(file).href];
}

test('CA-05.1 / CA-05.4 (gatilho independente) erro na verificação da aprovação', () => {
  const root = startedProject();
  driveTo(root, 'MERGING');
  const payload = bashPayload(root, 'gh pr merge 12 --squash');
  assert.equal(runHook(payload).status, 0); // controle: sem a falha, G3 válido libera

  const res = runHook(payload, { execArgv: brokenCryptoArgs() });
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /^\[agent-team\] BLOQUEADO: erro interno do guard ao avaliar Bash \(Error: falha injetada pelo teste\)/);
  assert.match(res.stderr, /informe o usuário/);
  assert.equal(/\n\s+at /.test(res.stderr), false); // nunca o stack

  // CA-05.2 com o mesmo gatilho: fora de projeto com time, a avaliação nem chega à falha
  assert.equal(runHook(bashPayload(tmpProject(), 'gh pr merge 12 --squash'), { execArgv: brokenCryptoArgs() }).status, 0);

  editConfig(root, (c) => { c.enforce = false; }); // CA-05.4
  assert.equal(runHook(payload, { execArgv: brokenCryptoArgs() }).status, 0);
});
