// Testa os hooks como o Claude Code os executa: processo separado, JSON no stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { core, startedProject, REPO } from './helpers.mjs';

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
  for (const prompt of ['ok, pode seguir', 'aprovado', 'APROVAR G1 mas mude o RF-02', 'acho que dá pra APROVAR G1']) {
    const res = run('prompt-approval.mjs', { cwd: root, prompt });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', prompt);
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
