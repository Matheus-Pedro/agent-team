import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';
import { build, parseFrontmatter } from '../scripts/build.mjs';
import { addOurHooks, removeOurHooks, PRE_TOOL_MATCHER } from '../scripts/settings-hooks.mjs';

const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', ...opts });

test('build gera um agente por papel com contrato comum e frontmatter válido', () => {
  const { agents, skills } = build({ quiet: true });
  assert.deepEqual(agents, [
    'architect', 'backend', 'code-reviewer', 'devops', 'documentation', 'frontend', 'product', 'qa-engineer',
  ]);
  assert.deepEqual(skills, ['orquestrar']);
  for (const a of agents) {
    const text = fs.readFileSync(path.join(REPO, 'dist', 'agents', `${a}.md`), 'utf8');
    const fm = parseFrontmatter(text, a);
    assert.equal(fm.fields.name, a);
    assert.ok(fm.fields.description.length > 40);
    assert.match(fm.body, /## Contrato comum do time/);
    assert.match(fm.body, /### Resultado \(formato obrigatório/);
  }
  const reviewer = parseFrontmatter(fs.readFileSync(path.join(REPO, 'dist', 'agents', 'code-reviewer.md'), 'utf8'));
  assert.doesNotMatch(reviewer.fields.tools, /Write|Edit/); // revisor é somente leitura
});

test('mescla de hooks preserva o que já existe e é idempotente', () => {
  const original = {
    enabledPlugins: { x: true },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo meu-hook' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }],
    },
  };
  const teamDir = 'C:\\Users\\x\\.claude\\team';
  const once = addOurHooks(original, teamDir);
  const twice = addOurHooks(once, teamDir);
  assert.deepEqual(twice, once);
  assert.equal(once.enabledPlugins.x, true);
  assert.equal(once.hooks.PreToolUse.length, 2);
  assert.equal(once.hooks.PreToolUse[1].matcher, PRE_TOOL_MATCHER);
  assert.equal(once.hooks.PreToolUse[1].hooks[0].command, 'node "C:/Users/x/.claude/team/hooks/guard.mjs"');
  assert.equal(once.hooks.UserPromptSubmit.length, 1);
  assert.deepEqual(removeOurHooks(once), original);
  assert.deepEqual(removeOurHooks({ a: 1 }), { a: 1 });
});

test('install/uninstall numa pasta temporária: CLI e hooks instalados funcionam', () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-claude-'));
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ agentPushNotifEnabled: true }));

  const res = node([path.join(REPO, 'scripts', 'install.mjs'), '--claude-dir', claude]);
  assert.equal(res.status, 0, res.stderr);
  for (const p of ['agents/product.md', 'agents/qa-engineer.md', 'skills/orquestrar/SKILL.md',
    'skills/orquestrar/reference/templates.md', 'team/bin/team.mjs', 'team/hooks/guard.mjs', 'team/approval.key']) {
    assert.ok(fs.existsSync(path.join(claude, p)), p);
  }
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.equal(settings.agentPushNotifEnabled, true);
  assert.ok(settings.hooks.UserPromptSubmit && settings.hooks.PreToolUse);
  assert.ok(fs.readdirSync(claude).some((f) => f.startsWith('settings.json.bak-')));

  // fluxo real com o runtime instalado
  const env = { ...process.env, AGENT_TEAM_HOME: path.join(claude, 'team') };
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-e2e-'));
  const team = (...args) => node([path.join(claude, 'team', 'bin', 'team.mjs'), ...args], { cwd: proj, env });
  assert.equal(team('init').status, 0);
  assert.equal(team('start', 'estoque', '--track', 'G', '--title', 'Controle de estoque').status, 0);
  assert.equal(team('move', 'WAITING_G1_APPROVAL').status, 0);
  const blocked = team('move', 'ARCHITECTING');
  assert.equal(blocked.status, 3);
  assert.match(blocked.stderr, /APROVAR G1/);

  const hook = node([path.join(claude, 'team', 'hooks', 'prompt-approval.mjs')], {
    input: JSON.stringify({ cwd: proj, prompt: 'APROVAR G1' }),
    env,
  });
  assert.match(hook.stdout, /APROVOU G1/);
  assert.equal(team('move', 'ARCHITECTING').status, 0);
  const status = JSON.parse(team('status', '--json').stdout);
  assert.equal(status.status, 'ARCHITECTING');
  assert.equal(status.gates.G1.approved, true);

  // reinstalar não duplica hooks nem troca a chave
  const key = fs.readFileSync(path.join(claude, 'team', 'approval.key'), 'utf8');
  assert.equal(node([path.join(REPO, 'scripts', 'install.mjs'), '--claude-dir', claude]).status, 0);
  const again = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.equal(again.hooks.PreToolUse.length, 1);
  assert.equal(fs.readFileSync(path.join(claude, 'team', 'approval.key'), 'utf8'), key);

  const un = node([path.join(REPO, 'scripts', 'uninstall.mjs'), '--claude-dir', claude]);
  assert.equal(un.status, 0, un.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.deepEqual(after, { agentPushNotifEnabled: true });
  assert.equal(fs.existsSync(path.join(claude, 'agents', 'product.md')), false);
  assert.equal(fs.existsSync(path.join(claude, 'team', 'approval.key')), true);
});
