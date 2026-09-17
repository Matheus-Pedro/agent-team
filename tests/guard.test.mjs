import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { rules, core, startedProject, driveTo, tmpProject, editConfig, TEAM_HOME } from './helpers.mjs';

const { evaluateToolCall, isStandaloneTeamCall } = rules;

const bash = (root, command, branch = 'team/w-001-estoque') =>
  evaluateToolCall({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { getBranch: () => branch });
const write = (root, file) =>
  evaluateToolCall({ tool_name: 'Write', tool_input: { file_path: path.join(root, file), content: 'x' }, cwd: root });

test('fora de projetos com .team nada é bloqueado', () => {
  const dir = tmpProject();
  assert.equal(bash(dir, 'git push origin main', 'main').deny, false);
  assert.equal(bash(dir, 'vercel --prod').deny, false);
});

test('chamada isolada do CLI é permitida; composta não', () => {
  const ok = [
    'node "$HOME/.claude/team/bin/team.mjs" status',
    'node "C:\\Users\\x\\.claude\\team\\bin\\team.mjs" move ARCHITECTING --reason "G1 ok"',
    "node ~/.claude/team/bin/team.mjs task add T1 --agent product --title 'Requisitos'",
  ];
  const bad = [
    'node "$HOME/.claude/team/bin/team.mjs" status && echo x > .team/state.json',
    'node "$HOME/.claude/team/bin/team.mjs" status; rm -rf .team',
    'node "$(echo pwn)/.claude/team/bin/team.mjs" status',
    'echo hacked > ~/.claude/team/bin/team.mjs',
  ];
  for (const c of ok) assert.equal(isStandaloneTeamCall(c), true, c);
  for (const c of bad) assert.equal(isStandaloneTeamCall(c), false, c);

  const root = startedProject();
  for (const c of bad) assert.equal(bash(root, c).deny, true, c);
});

test('arquivos de estado, aprovações, config, runtime e settings são protegidos', () => {
  const root = startedProject();
  for (const f of ['.team/state.json', '.team/config.json', '.team/approvals/W-001-estoque/G1.json', '.team/logs/orchestration.jsonl']) {
    assert.equal(write(root, f).deny, true, f);
  }
  assert.equal(
    evaluateToolCall({ tool_name: 'Edit', tool_input: { file_path: path.join(os.homedir(), '.claude', 'settings.json') }, cwd: root }).deny,
    true,
  );
  assert.equal(write(root, '.claude/settings.local.json').deny, true);
  assert.equal(
    evaluateToolCall({ tool_name: 'Write', tool_input: { file_path: path.join(os.homedir(), '.claude', 'team', 'bin', 'team.mjs') }, cwd: root }).deny,
    true,
  );
  assert.equal(write(root, '.team/work/W-001-estoque/plan.md').deny, false);
  assert.equal(write(root, 'src/api/produtos.ts').deny, false);
  assert.equal(
    evaluateToolCall({ tool_name: 'Read', tool_input: { file_path: path.join(TEAM_HOME, 'approval.key') }, cwd: root }).deny,
    true,
  );
  assert.equal(evaluateToolCall({ tool_name: 'Read', tool_input: { file_path: path.join(root, '.team', 'state.json') }, cwd: root }).deny, false);
});

test('shell não pode mexer em .team nem burlar via git clean/settings', () => {
  const root = startedProject();
  for (const c of [
    'cat .team/state.json',
    'rm -rf .team',
    'Remove-Item -Recurse .team',
    'mv ./.team /tmp/x',
    'git clean -fdx',
    'cat ~/.claude/team/approval.key',
    'echo {} > ~/.claude/settings.json',
    'node ~/.claude/team/hooks/prompt-approval.mjs',
  ]) {
    assert.equal(bash(root, c).deny, true, c);
  }
  for (const c of ['git clean -fd', 'npm test', 'ls -la', 'git status']) {
    assert.equal(bash(root, c).deny, false, c);
  }
});

test('merge/push/commit na branch principal só em MERGING com G3', () => {
  const root = startedProject({ git: true });
  driveTo(root, 'IMPLEMENTING');
  // trabalho normal na branch do work item
  assert.equal(bash(root, 'git commit -m "feat: api de produtos"').deny, false);
  assert.equal(bash(root, 'git push -u origin team/w-001-estoque').deny, false);
  assert.equal(bash(root, 'git merge main').deny, false); // atualizar a branch de trabalho
  assert.equal(bash(root, 'git push origin main-backup-notes').deny, false);
  // caminhos até a principal
  assert.equal(bash(root, 'git checkout main && git merge team/w-001-estoque').deny, true);
  assert.equal(bash(root, 'git merge team/w-001-estoque', 'main').deny, true);
  assert.equal(bash(root, 'git commit -m hotfix', 'main').deny, true);
  assert.equal(bash(root, 'git push', 'main').deny, true);
  assert.equal(bash(root, 'git push origin main').deny, true);
  assert.equal(bash(root, 'git push origin HEAD:main').deny, true);
  assert.equal(bash(root, 'gh pr merge 12 --squash').deny, true);
  assert.equal(bash(root, 'git branch -f main HEAD').deny, true);
});

test('merge liberado somente após G3 aprovado', () => {
  const root = startedProject({ git: true });
  driveTo(root, 'WAITING_G3_APPROVAL');
  assert.equal(bash(root, 'gh pr merge 12 --squash').deny, true);
  core.recordDecision(root, { gate: 'G3', decision: 'approved' });
  assert.equal(bash(root, 'gh pr merge 12 --squash').deny, true); // ainda não moveu para MERGING
  core.moveTo(root, 'MERGING');
  assert.equal(bash(root, 'gh pr merge 12 --squash').deny, false);
  assert.equal(bash(root, 'git merge team/w-001-estoque', 'main').deny, false);
  core.moveTo(root, 'MERGED');
  assert.equal(bash(root, 'git push origin main').deny, true);
});

test('deploy exige DEPLOYING + G4; produção exige DEPLOYING_PROD + PROD', () => {
  const root = startedProject();
  driveTo(root, 'PREPARING_DEPLOY');
  assert.equal(bash(root, 'docker build -t app .').deny, false);
  assert.equal(bash(root, 'docker push registry/app:1.0').deny, true);
  assert.equal(bash(root, 'kubectl apply -f k8s/staging').deny, true);

  core.moveTo(root, 'WAITING_G4_APPROVAL');
  core.recordDecision(root, { gate: 'G4', decision: 'approved' });
  core.moveTo(root, 'DEPLOYING');
  assert.equal(bash(root, 'kubectl apply -f k8s/staging').deny, false);
  assert.equal(bash(root, 'kubectl apply -f k8s/production').deny, true);
  assert.equal(bash(root, 'vercel --prod').deny, true);
  assert.equal(bash(root, 'vercel dev').deny, false);

  core.moveTo(root, 'WAITING_PROD_APPROVAL');
  assert.equal(bash(root, 'vercel --prod').deny, true);
  core.recordDecision(root, { gate: 'PROD', decision: 'approved' });
  core.moveTo(root, 'DEPLOYING_PROD');
  assert.equal(bash(root, 'vercel --prod').deny, false);
});

test('config com enforce=false desliga o guard (decisão do usuário)', () => {
  const root = startedProject();
  editConfig(root, (c) => {
    c.enforce = false;
  });
  assert.equal(bash(root, 'git push origin main', 'main').deny, false);
});
