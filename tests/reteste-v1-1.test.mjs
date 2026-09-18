// QA (TT2): reteste das correções da revisão da v1.1 (commit e438bc9), no nível do hook,
// rodando como o harness roda (processo separado, JSON no stdin). Os testes unitários dos
// implementadores estão em guard.test.mjs e prompt-rules.test.mjs; aqui ficam só as lacunas:
//   - vetores de escape por aspas, pelo hook, com as ferramentas Bash **e** PowerShell;
//   - alias de um ANCESTRAL da chave (perfil por compartilhamento administrativo, diretório
//     do Claude por nome 8.3) numa instalação padrão (sem AGENT_TEAM_HOME, home temporário);
//   - `APROVAR G1?`, `APROVAR G1;` e `REPROVAR G1; motivo` pelo hook de prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { core, startedProject, REPO } from './helpers.mjs';

const GUARD_HOOK = path.join(REPO, 'runtime', 'hooks', 'guard.mjs');
const PROMPT_HOOK = path.join(REPO, 'runtime', 'hooks', 'prompt-approval.mjs');
const IS_WIN = process.platform === 'win32';

const spawnHook = (hook, payload, env = process.env) =>
  spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8', env });

// ---------------------------------------------------------------- BLOCKER 2: escape por aspas

/* Três vetores do revisor, cada um em duas formas: a do teste do implementador e uma forma
   balanceada que o QA executou de verdade, com carga inofensiva (`echo`), e que imprimiu a
   linha injetada: `"a\" ; X ; \"b"` e aspas tipográficas no powershell.exe 5.1, e
   `$'x\'' ; X ; echo 'fim'` no bash. Aqui a carga é destrutiva, porque nada é executado:
   só o guard avalia o texto. */
const CLI_DQ = 'node "$HOME/.claude/team/bin/team.mjs" move TESTING --reason';
const CLI_BARE = 'node ~/.claude/team/bin/team.mjs move TESTING --reason';
const VETORES = {
  PowerShell: [
    `${CLI_DQ} "a\\" ; Remove-Item -Recurse -Force .team ; \\"b"`,
    `${CLI_DQ} "a\\" && Remove-Item -Recurse -Force .team`,
    `${CLI_DQ} "a\\" | Out-File .team/state.json`,
    `${CLI_DQ} "a\u201c; Remove-Item -Recurse -Force .team; \u201cb"`,
    `${CLI_DQ} "a\u201d; Remove-Item -Recurse -Force .team; \u201db"`,
    `${CLI_DQ} "a\u201e; Remove-Item -Recurse -Force .team; \u201eb"`,
    `${CLI_BARE} 'a\u2019; Remove-Item -Recurse -Force .team; \u2018b'`,
  ],
  Bash: [
    `${CLI_BARE} $'x\\'' ; rm -rf .team ; echo '`,
    `${CLI_BARE} $'x\\'' ; rm -rf .team ; echo 'fim'`,
    `${CLI_BARE} $'x\\'' && rm -rf .team`,
    `${CLI_BARE} $'x\\'' | tee .team/state.json`,
  ],
};

test('BLOCKER 2 (hook) os vetores de escape por aspas são bloqueados, com Bash e PowerShell', () => {
  const root = startedProject();
  for (const tool of ['Bash', 'PowerShell']) {
    for (const command of [...VETORES.PowerShell, ...VETORES.Bash]) {
      const res = spawnHook(GUARD_HOOK, { hook_event_name: 'PreToolUse', cwd: root, tool_name: tool, tool_input: { command } });
      assert.equal(res.status, 2, `${tool}: ${command}\n${res.stderr}`);
      assert.match(res.stderr, /^\[agent-team\] BLOQUEADO: /, command);
    }
  }
  assert.ok(fs.existsSync(path.join(root, '.team', 'state.json'))); // nada foi executado, claro
});

test('BLOCKER 2 (hook) a chamada isolada sem metacaractere continua liberada (regra estrita da v1.0)', () => {
  const root = startedProject();
  for (const tool of ['Bash', 'PowerShell']) {
    for (const command of [
      'node "$HOME/.claude/team/bin/team.mjs" status',
      `${CLI_DQ} "G1 ok, ajustar RF-02"`,
      'node "C:\\Users\\alguem\\.claude\\team\\bin\\team.mjs" status --json',
    ]) {
      const res = spawnHook(GUARD_HOOK, { hook_event_name: 'PreToolUse', cwd: root, tool_name: tool, tool_input: { command } });
      assert.equal(res.status, 0, `${tool}: ${command}\n${res.stderr}`);
    }
  }
});

/* Brecha pré-existente (v1.0) achada na rechecagem do revisor (TR2): no PowerShell, `( )` e
   `@( )` executam comandos em modo de argumento. Correção em andamento na tarefa TP (backend):
   `(` e `)` passam a ser proibidos na chamada isolada do CLI, em todos os shells.
   ESTE TESTE FALHA ATÉ A TP ENTRAR NA ÁRVORE. */
test('TP (hook) ( ) e @( ) na chamada do CLI são bloqueados, com Bash e PowerShell', () => {
  const root = startedProject();
  const vetores = [
    'node "$HOME/.claude/team/bin/team.mjs" status (git merge feat)',
    'node "$HOME/.claude/team/bin/team.mjs" status @(git merge feat)',
    'node ~/.claude/team/bin/team.mjs status (Remove-Item -Recurse -Force .team)',
    'node ~/.claude/team/bin/team.mjs status @(Remove-Item -Recurse -Force .team)',
    `${CLI_DQ} "motivo" (git push origin main)`,
    'node "$HOME/.claude/team/bin/team.mjs" status ( git merge feat )',
  ];
  for (const tool of ['Bash', 'PowerShell']) {
    for (const command of vetores) {
      const res = spawnHook(GUARD_HOOK, { hook_event_name: 'PreToolUse', cwd: root, tool_name: tool, tool_input: { command } });
      assert.equal(res.status, 2, `${tool}: ${command}\n${res.stderr}`);
      assert.match(res.stderr, /^\[agent-team\] BLOQUEADO: /, command);
    }
  }
});

// ---------------------------------------------------------------- MAJOR 3: alias de ancestral da chave

/** Nome curto 8.3 real, pelo próprio Windows; devolve o mesmo caminho se o volume não gerar. */
function shortName(p) {
  try {
    return execFileSync('cmd', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    }).trim();
  } catch {
    return p;
  }
}
/** `C:\x\y` → `\\<host>\c$\x\y` */
const adminShare = (p, host = 'localhost') => `\\\\${host}\\${p[0].toLowerCase()}$\\${p.slice(3)}`;

/** Instalação padrão simulada: home temporário com `.claude/team` de verdade no disco. */
function fakeInstall() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-perfil-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'team', 'lib'), { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!['AGENT_TEAM_HOME', 'USERPROFILE', 'HOME'].includes(k.toUpperCase())) env[k] = v;
  }
  return { home, claude, env: { ...env, USERPROFILE: home, HOME: home } };
}
const grep = (cwd, alvo) => ({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Grep', tool_input: { pattern: 'x', path: alvo } });
const glob = (cwd, alvo) => ({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Glob', tool_input: { pattern: '**/*', path: alvo } });

test('MAJOR 3 (hook, instalação padrão) alias de ancestral da chave é bloqueado: perfil e diretório do Claude', { skip: !IS_WIN }, (t) => {
  const root = startedProject();
  const { home, claude, env } = fakeInstall();
  const aliases = [
    adminShare(home), // perfil do usuário pelo compartilhamento administrativo
    adminShare(home, '127.0.0.1'),
    adminShare(home, os.hostname()),
    `\\\\?\\UNC\\${adminShare(home).slice(2)}`,
    `\\\\.\\UNC\\${adminShare(home).slice(2)}`,
    `\\\\.\\${home}`,
    `\\\\?\\${home}`,
    adminShare(claude), // diretório do Claude pelo compartilhamento
    `\\\\localhost\\${home[0].toLowerCase()}$`, // raiz do volume pelo compartilhamento
    `//localhost/${home[0].toLowerCase()}$/${home.slice(3).replace(/\\/g, '/')}`,
  ];
  const curtos = [shortName(claude), shortName(home)].filter((s, i) => s !== [claude, home][i]);
  if (curtos.length === 0) t.diagnostic('o volume do %TEMP% não gerou nomes 8.3; a expansão real não foi exercitada');
  for (const c of curtos) assert.match(c, /~\d/, c);
  aliases.push(...curtos, ...curtos.map((c) => adminShare(c)));

  for (const alvo of aliases) {
    for (const payload of [grep(root, alvo), glob(root, alvo)]) {
      const res = spawnHook(GUARD_HOOK, payload, env);
      assert.equal(res.status, 2, `${payload.tool_name} ${alvo}\n${res.stderr}`);
      assert.match(res.stderr, /^\[agent-team\] BLOQUEADO: .*(chave de assinatura|nome curto)/, alvo);
    }
  }
  // prefixo estático do padrão de Glob também é alvo (sem `path`)
  const g = spawnHook(GUARD_HOOK, {
    hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Glob', tool_input: { pattern: `${adminShare(home)}\\**\\*` },
  }, env);
  assert.equal(g.status, 2, g.stderr);

  // controles: o projeto e um irmão de .claude, pelo mesmo tipo de alias, continuam liberados
  const irmao = path.join(home, 'Documentos');
  fs.mkdirSync(irmao);
  for (const alvo of [adminShare(root), adminShare(irmao), `\\\\.\\${irmao}`, shortName(irmao), '\\\\outro-servidor\\c$\\Users']) {
    const res = spawnHook(GUARD_HOOK, grep(root, alvo), env);
    assert.equal(res.status, 0, `${alvo}\n${res.stderr}`);
  }
  assert.equal(fs.existsSync(path.join(claude, 'team', path.basename(core.KEY_FILE))), false); // nada criado
});

// ---------------------------------------------------------------- BLOCKER 1: `?` e `;` pelo hook

test('BLOCKER 1 (hook) APROVAR G1? / APROVAR G1; / REPROVAR G1; motivo: nada registrado e nada emitido', () => {
  const root = startedProject();
  core.moveTo(root, 'WAITING_G1_APPROVAL');
  const log = path.join(root, '.team', 'logs', 'orchestration.jsonl');
  const antes = fs.readFileSync(log, 'utf8');
  for (const prompt of ['APROVAR G1?', 'aprovar g1?', 'APROVAR G1;', 'APROVAR G1 ?', 'Aprovado G1?', 'REPROVAR G1; faltou o ADR',
    'REPROVAR G1?', 'APROVAR?']) {
    const res = spawnHook(PROMPT_HOOK, { hook_event_name: 'UserPromptSubmit', cwd: root, prompt });
    assert.equal(res.status, 0, prompt);
    assert.equal(res.stdout, '', prompt);
  }
  assert.equal(fs.readFileSync(log, 'utf8'), antes);
  assert.deepEqual(fs.readdirSync(path.join(root, '.team', 'approvals')).flatMap((d) =>
    fs.readdirSync(path.join(root, '.team', 'approvals', d))), []);
  assert.equal(core.checkApproval(root, core.loadState(root), 'G1').valid, false);

  // controle: as formas válidas continuam registrando
  const ok = spawnHook(PROMPT_HOOK, { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'REPROVAR G1: faltou o ADR' });
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /REPROVOU G1.*faltou o ADR/);
  const ap = spawnHook(PROMPT_HOOK, { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'APROVAR G1!' });
  assert.match(JSON.parse(ap.stdout).hookSpecificOutput.additionalContext, /APROVOU G1/);
});
