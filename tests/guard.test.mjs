import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { rules, core, startedProject, driveTo, tmpProject, editConfig, TEAM_HOME, REPO } from './helpers.mjs';

const paths = await import('../runtime/lib/paths.mjs');

const { evaluateToolCall, isStandaloneTeamCall, searchTargets, enforcementContext, classifyGitCommand } = rules;

const bash = (root, command, branch = 'team/w-001-estoque') =>
  evaluateToolCall({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { getBranch: () => branch });
const write = (root, file) =>
  evaluateToolCall({ tool_name: 'Write', tool_input: { file_path: path.join(root, file), content: 'x' }, cwd: root });
const search = (root, tool, tool_input) => evaluateToolCall({ tool_name: tool, tool_input, cwd: root });
const read = (root, file) => evaluateToolCall({ tool_name: 'Read', tool_input: { file_path: file }, cwd: root });

const KEY_FILE = path.join(TEAM_HOME, 'approval.key');
const GUARD_HOOK = path.join(REPO, 'runtime', 'hooks', 'guard.mjs');

/** Projeto com `.team/` ativo e um repositório git **real** (o `tmpProject({git:true})` só cria `.git/`). */
function gitProject({ commit = true, branch = 'team/w-001-estoque' } = {}) {
  const dir = tmpProject();
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git('config', 'user.email', 'guard@example.invalid');
  git('config', 'user.name', 'guard-test');
  if (commit) {
    fs.writeFileSync(path.join(dir, 'README.md'), '# projeto temporário\n');
    git('add', '.');
    git('commit', '-m', 'commit base');
    if (branch !== 'main') git('checkout', '-b', branch);
  }
  core.initTeam(dir);
  core.startWork(dir, { slug: 'estoque', title: 'Controle de estoque', track: 'G' });
  driveTo(dir, 'IMPLEMENTING');
  return dir;
}

/** Roda o hook como o harness roda: processo separado, JSON no stdin. */
const runHook = (payload, { input } = {}) =>
  spawnSync(process.execPath, [GUARD_HOOK], {
    input: input ?? JSON.stringify(payload),
    encoding: 'utf8',
    env: process.env,
  });

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

// ---------------------------------------------------------------- US-01 (ADR-001)

test('CA-01.1 repositório sem commit base: commit na principal é bloqueado com a frase do commit base', () => {
  const root = gitProject({ commit: false }); // git init -b main, nenhum commit
  const res = evaluateToolCall({ tool_name: 'Bash', tool_input: { command: 'git commit -m "feat: x"' }, cwd: root });
  assert.equal(res.deny, true); // era o fail-open do B-01: a v1.0 liberava
  assert.match(res.reason, /commit base/);
  assert.match(res.reason, /usuário, no terminal dele/); // quem faz o quê (RNF-05)
});

test('CA-01.5 repositório com commit base, na branch do work item: commit é permitido', () => {
  const root = gitProject();
  assert.equal(evaluateToolCall({ tool_name: 'Bash', tool_input: { command: 'git commit -m "feat: x"' }, cwd: root }).deny, false);
  assert.equal(evaluateToolCall({ tool_name: 'Bash', tool_input: { command: 'git push -u origin HEAD' }, cwd: root }).deny, false);
});

test('CA-01.1 repositório com commit base, na principal: bloqueia sem a frase do commit base', () => {
  const root = gitProject({ branch: 'main' });
  const res = evaluateToolCall({ tool_name: 'Bash', tool_input: { command: 'git commit -m "hotfix"' }, cwd: root });
  assert.equal(res.deny, true);
  assert.match(res.reason, /MERGING/);
  assert.equal(/commit base/.test(res.reason), false);
});

test('CA-01.2 branch indeterminada bloqueia tudo que altera histórico', () => {
  const root = startedProject();
  driveTo(root, 'IMPLEMENTING');
  const unknown = (command, value = null) =>
    evaluateToolCall({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { getBranch: () => value });
  for (const c of [
    'git commit -m x',
    'git merge outra',
    'git rebase main',
    'git push',
    'git cherry-pick abc123',
    'git revert abc123',
    'git am patch.diff',
  ]) {
    const res = unknown(c);
    assert.equal(res.deny, true, c);
    assert.match(res.reason, /não foi possível identificar a branch atual/i, c);
    assert.match(res.reason, /usuário/, c); // RNF-05: próximo passo
  }
  // `null` e BranchInfo explícito têm o mesmo efeito (normalizeBranchInfo)
  const exato = unknown('git commit -m x', { kind: 'unknown', detail: 'git não encontrado no PATH' });
  assert.equal(exato.deny, true);
  // texto exato: o próximo passo aparece uma vez só (achado 4 da revisão)
  assert.equal(
    exato.reason,
    'Não foi possível identificar a branch atual (git não encontrado no PATH). Comandos que alteram histórico ' +
      'ficam bloqueados até isso ser resolvido; peça ao usuário para verificar o repositório. O comando não foi executado.',
  );
  // o que não altera histórico continua liberado
  assert.equal(unknown('git status').deny, false);
  assert.equal(unknown('git log --oneline').deny, false);
});

test('CA-01.7 HEAD destacado mantém o comportamento da v1.0', () => {
  const root = startedProject();
  driveTo(root, 'IMPLEMENTING');
  const detached = (command) =>
    evaluateToolCall({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { getBranch: () => ({ kind: 'detached', name: null }) });
  assert.equal(detached('git commit -m x').deny, false);
  assert.equal(detached('git merge outra').deny, false);
  // alvo explícito na principal continua bloqueado mesmo destacado
  assert.equal(detached('git checkout main && git merge team/w-001-estoque').deny, true);
  assert.equal(detached('git push origin main').deny, true);
  assert.equal(detached('gh pr merge 12').deny, true);
});

test('sem repositório git a regra de histórico não se aplica; as outras continuam', () => {
  const root = startedProject();
  driveTo(root, 'PREPARING_DEPLOY');
  const noRepo = (command) =>
    evaluateToolCall({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { getBranch: () => ({ kind: 'no-repo', name: null }) });
  assert.equal(noRepo('git commit -m x').deny, false);
  assert.equal(noRepo('docker push registry/app:1.0').deny, true); // deploy
  assert.equal(noRepo('cat .team/state.json').deny, true); // caminho protegido
});

test('classifyGitCommand olha só o texto e o alvo incondicional tem precedência', () => {
  const mains = ['main', 'master'];
  assert.equal(classifyGitCommand('npm test', mains), null);
  assert.equal(classifyGitCommand('git status', mains), null);
  assert.equal(classifyGitCommand('git commit -m x', mains).targetsMain, false);
  assert.equal(classifyGitCommand('git checkout main && git commit -m x', mains).targetsMain, true);
  assert.equal(classifyGitCommand('gh pr merge 1', mains).targetsMain, true);
  // dois verbos na mesma linha: quem alcança a principal decide
  assert.equal(classifyGitCommand('git merge outra && git push origin main', mains).targetsMain, true);
  assert.equal(classifyGitCommand('git push && git branch -D master', mains).targetsMain, true);
  // trilha de `main_branches` customizada
  assert.equal(classifyGitCommand('git commit -m x', ['trunk']).targetsMain, false);
  assert.equal(classifyGitCommand('git checkout trunk && git commit -m x', ['trunk']).targetsMain, true);
});

test('guard-rules não executa git: quem fala com o git é lib/git.mjs (ADR-001)', () => {
  const src = fs.readFileSync(path.join(REPO, 'runtime', 'lib', 'guard-rules.mjs'), 'utf8');
  assert.equal(/execFileSync|execSync|spawnSync|child_process/.test(src), false);
  assert.match(src, /from '\.\/git\.mjs'/);
});

// ---------------------------------------------------------------- US-03 (ADR-003)

test('CA-03.1/CA-03.2 busca com alvo no projeto é liberada, com qualquer padrão', () => {
  const root = startedProject();
  const literais = ['.claude/team', '.team/state.json', '.team/config.json', 'approval.key', '\\.claude/team'];
  for (const pattern of literais) {
    assert.equal(search(root, 'Grep', { pattern, path: root }).deny, false, `Grep ${pattern}`);
    assert.equal(search(root, 'Grep', { pattern }).deny, false, `Grep sem path ${pattern}`);
    assert.equal(search(root, 'Glob', { pattern: `**/*${pattern}*` }).deny, false, `Glob ${pattern}`);
  }
  assert.equal(search(root, 'Grep', { pattern: 'KEY_FILE', glob: '**/*.mjs', path: path.join(root, 'src') }).deny, false);
  assert.equal(search(root, 'Glob', { pattern: '**/approval.key', path: root }).deny, false);
});

test('CA-03.3 busca cujo alvo alcança a chave é bloqueada', () => {
  const root = startedProject();
  const alvos = [
    KEY_FILE,
    TEAM_HOME,
    path.join(TEAM_HOME, 'bin'), // subdiretório do runtime instalado
    path.dirname(TEAM_HOME), // ancestral (~/.claude no mundo real)
    path.dirname(path.dirname(TEAM_HOME)), // ancestral (~)
    path.parse(TEAM_HOME).root, // raiz do volume
  ];
  for (const alvo of alvos) {
    const res = search(root, 'Grep', { pattern: '[0-9a-f]{64}', path: alvo });
    assert.equal(res.deny, true, alvo);
    assert.match(res.reason, /chave de assinatura/);
    assert.match(res.reason, /restrinja o alvo/);
    assert.equal(search(root, 'Glob', { pattern: '**/*', path: alvo }).deny, true, alvo);
  }
  // prefixo estático absoluto no padrão, sem `path` (B-04 por outro caminho)
  assert.equal(search(root, 'Glob', { pattern: path.join(TEAM_HOME, '**', '*.key') }).deny, true);
  assert.equal(search(root, 'Grep', { pattern: 'x', glob: path.join(TEAM_HOME, '**') }).deny, true);
  // `..` que sobe até o runtime instalado
  const subida = path.relative(root, TEAM_HOME);
  assert.equal(search(root, 'Grep', { pattern: 'x', path: subida }).deny, true, subida);
});

test('CA-03.4 Read: só a chave é bloqueada', () => {
  const root = startedProject();
  const res = read(root, KEY_FILE);
  assert.equal(res.deny, true);
  assert.match(res.reason, /chave de assinatura/);
  assert.match(res.reason, /team status/); // RNF-05: o que fazer em vez disso
  assert.equal(read(root, path.join(TEAM_HOME, 'bin', 'team.mjs')).deny, false);
  assert.equal(read(root, path.join(TEAM_HOME, 'lib', 'guard-rules.mjs')).deny, false);
  assert.equal(read(root, path.join(root, '.team', 'state.json')).deny, false);
  assert.equal(read(root, TEAM_HOME).deny, false); // diretório: Read não é recursivo
});

test('CA-03.5 mensagens de shell indicam a alternativa nativa', () => {
  const root = startedProject();
  assert.match(bash(root, 'cat ~/.claude/team/approval.key').reason, /Grep|Glob/);
  assert.match(bash(root, 'grep -r x ~/.claude/team').reason, /Read, Grep ou Glob/);
  assert.match(bash(root, 'cat .team/state.json').reason, /Read/);
  assert.match(bash(root, 'ls .team/approvals').reason, /team status|Read/);
});

test('searchTargets ignora o texto do padrão e considera o alvo', () => {
  const cwd = path.join(os.tmpdir(), 'proj-x');
  assert.deepEqual(searchTargets('Grep', { pattern: '[0-9a-f]{64}' }, cwd), [cwd]);
  assert.deepEqual(searchTargets('Grep', { pattern: '.claude/team' }, cwd), [cwd]);
  assert.deepEqual(searchTargets('Glob', { pattern: '**/*.mjs' }, cwd), [cwd]);
  assert.deepEqual(searchTargets('Grep', { pattern: '/' }, cwd), [cwd]); // raiz sozinha não é alvo
  /* Limite conhecido e inofensivo: no Windows um padrão de regex que começa com `\`
     é "absoluto" e entra como alvo relativo à unidade (`C:\.claude\team`), que nunca
     alcança a chave (fica sob o diretório do usuário). A decisão não muda. */
  assert.deepEqual(searchTargets('Grep', { pattern: '\\.claude/team' }, cwd),
    process.platform === 'win32' ? [cwd, path.resolve('\\.claude/team')] : [cwd]);
  assert.deepEqual(searchTargets('Read', { file_path: 'a/b.md' }, cwd), [path.join(cwd, 'a', 'b.md')]);
  assert.deepEqual(searchTargets('Bash', { command: 'ls' }, cwd), []);
  const absoluto = path.join(os.tmpdir(), 'alvo', 'x');
  assert.deepEqual(searchTargets('Glob', { pattern: `${absoluto}/**` }, cwd), [cwd, absoluto]);
});

test('paths.mjs: comparação estrutural, sem armadilha de prefixo nem regex', () => {
  const { isInside, isSameOrAncestor, staticPrefix, normalizeTarget, stripLongPrefix } = paths;
  const sep = path.sep;
  const A = `${path.parse(process.cwd()).root}a${sep}bar`;
  assert.equal(isInside(A, `${A}${sep}x`), true);
  assert.equal(isInside(A, `${path.parse(process.cwd()).root}a${sep}barbaz`), false); // o bug do startsWith
  assert.equal(isInside(A, A), false);
  assert.equal(isInside(`${A}${sep}x`, A), false);
  assert.equal(isInside(A, `${A}${sep}..foo`), true); // `..foo` é nome, não subida
  assert.equal(isSameOrAncestor(A, A), true);
  assert.equal(isSameOrAncestor(A, `${A}${sep}x${sep}y`), true);
  // caixa: semântica da plataforma (Windows ignora, POSIX diferencia)
  assert.equal(isSameOrAncestor(A.toUpperCase(), A), process.platform === 'win32');
  assert.equal(stripLongPrefix('\\\\?\\C:\\x'), 'C:\\x');
  assert.equal(stripLongPrefix('\\\\?\\UNC\\srv\\share\\x'), '\\\\srv\\share\\x');
  assert.equal(normalizeTarget('\\\\?\\C:\\p', 'a'), path.join('C:\\p', 'a'));
  assert.equal(staticPrefix('C:/u/.claude/team/**'), 'C:/u/.claude/team');
  assert.equal(staticPrefix('src/**/*.ts'), 'src');
  assert.equal(staticPrefix('README.md'), 'README.md');
  assert.equal(staticPrefix('C:/**'), 'C:/');
  assert.equal(staticPrefix('**/*.mjs'), '');
});

// ---------------------------------------------------------------- US-05 (ADR-005)

/* Para forçar um erro interno determinístico sem mexer no código do guard,
   corrompemos `main_branches` com um valor não-string: `escapeRe` lança ao
   classificar o comando git. É o mais parecido com um bug real nas regras. */
const breakRules = (root) => editConfig(root, (c) => {
  c.main_branches = [5];
});
const gitPayload = (cwd) => ({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });

test('CA-05.1 erro interno dentro de projeto com time ativo bloqueia (exit 2)', () => {
  const root = gitProject();
  breakRules(root);
  assert.throws(() => evaluateToolCall(gitPayload(root))); // o erro é real, não simulado no hook
  const res = runHook(gitPayload(root));
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /^\[agent-team\] BLOQUEADO: erro interno do guard ao avaliar Bash/);
  assert.match(res.stderr, /reporte o erro/);
  assert.match(res.stderr, /enforce: false/);
  assert.equal(res.stdout, '');
  assert.equal(/\n\s+at /.test(res.stderr), false); // nunca o stack
});

test('CA-05.2 erro interno fora de projeto com time é ignorado (exit 0)', () => {
  const dir = tmpProject();
  // `path: []` faz `path.resolve` lançar TypeError já na descoberta do projeto
  const payload = { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Read', tool_input: { path: [] } };
  const res = runHook(payload);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /erro interno/);
  assert.equal(/BLOQUEADO/.test(res.stderr), false);
});

test('CA-05.3 entrada que não é JSON continua liberada', () => {
  for (const input of ['isso não é json', '', '{"tool_name":']) {
    assert.equal(runHook(null, { input }).status, 0, JSON.stringify(input));
  }
});

test('CA-05.4 com enforce=false o erro interno não bloqueia', () => {
  const root = gitProject();
  breakRules(root);
  editConfig(root, (c) => {
    c.enforce = false;
  });
  assert.equal(enforcementContext(gitPayload(root)).enforcing, false);
  assert.equal(runHook(gitPayload(root)).status, 0);
});

test('enforcementContext: time ativo, config corrompida, fora de projeto', () => {
  const root = startedProject();
  const payload = gitPayload(root);
  assert.equal(enforcementContext(payload).enforcing, true);
  assert.equal(enforcementContext(payload).root, root);

  fs.writeFileSync(path.join(root, '.team', 'config.json'), '{ isso não é json');
  assert.equal(enforcementContext(payload).enforcing, true); // na dúvida, aplica

  const fora = tmpProject();
  assert.deepEqual(enforcementContext(gitPayload(fora)), { root: null, enforcing: false });
  // nunca lança, nem com entrada absurda (o hook depende disso)
  assert.deepEqual(enforcementContext({ cwd: 42 }), { root: null, enforcing: false });
  assert.deepEqual(enforcementContext({ cwd: fora, tool_input: { path: [] } }), { root: null, enforcing: false });
  assert.doesNotThrow(() => enforcementContext(undefined));
});

test('o guard continua bloqueando e liberando pelo hook (regressão do exit code)', () => {
  const root = startedProject();
  const bloqueado = runHook({
    hook_event_name: 'PreToolUse',
    cwd: root,
    tool_name: 'Write',
    tool_input: { file_path: path.join(root, '.team', 'state.json'), content: '{}' },
  });
  assert.equal(bloqueado.status, 2);
  assert.match(bloqueado.stderr, /^\[agent-team\] BLOQUEADO: /);
  const liberado = runHook({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Grep', tool_input: { pattern: '.claude/team' } });
  assert.equal(liberado.status, 0, liberado.stderr);
});

// ---------------------------------------------------------------- lista branca do CLI (US-07 retirada)

/* A US-07 saiu da v1.1 (revisão, achado 2): metacaractere **em qualquer lugar**, dentro ou
   fora de aspas, invalida a chamada isolada. Os três vetores abaixo foram executados pelo
   revisor em powershell.exe e bash: o shell vê o `;` fora de aspas, um scanner de aspas não. */
test('vetores de injeção da revisão são bloqueados (PowerShell \\", aspas tipográficas, bash $\'...\')', () => {
  const vetores = [
    // PowerShell: `\` não é escape, então `"a\"` fecha a string e o `;` executa
    'node "$HOME/.claude/team/bin/team.mjs" move TESTING --reason "a\\" ; Remove-Item -Recurse -Force .team ; \\"b"',
    // PowerShell: aspas tipográficas fecham a string aberta com `"`
    'node "$HOME/.claude/team/bin/team.mjs" move TESTING --reason "a\u201c; Remove-Item -Recurse -Force .team; \u201cb"',
    // bash: `$'x\''` é x' (ANSI-C), e o resto roda fora de aspas
    "node ~/.claude/team/bin/team.mjs move TESTING --reason $'x\\'' ; rm -rf .team ; echo '",
  ];
  const root = startedProject();
  for (const c of vetores) {
    assert.equal(isStandaloneTeamCall(c), false, c);
    const res = bash(root, c);
    assert.equal(res.deny, true, c);
    assert.match(res.reason, /nem mesmo entre aspas/);
  }
});

test('metacaractere entre aspas volta a invalidar a chamada isolada (regra estrita da v1.0)', () => {
  const root = startedProject();
  for (const c of [
    'node "$HOME/.claude/team/bin/team.mjs" move ARCHITECTING --reason "G1 ok; ajustar RF-02"',
    'node "$HOME/.claude/team/bin/team.mjs" task add T1 --agent backend --title "API & regras"',
    "node ~/.claude/team/bin/team.mjs move TESTING --reason 'a | b'",
    "node ~/.claude/team/bin/team.mjs move TESTING --reason 'a > b'",
    'node ~/.claude/team/bin/team.mjs move TESTING --reason "`whoami`"',
    'node ~/.claude/team/bin/team.mjs move TESTING --reason "$(whoami)"',
    'node ~/.claude/team/bin/team.mjs status\nrm -rf .team',
  ]) {
    assert.equal(isStandaloneTeamCall(c), false, c);
    assert.equal(bash(root, c).deny, true, c);
  }
  // sem metacaractere, inclusive com acento e $VAR, continua isolada
  for (const c of [
    'node "$HOME/.claude/team/bin/team.mjs" start --title "Evolução do runtime"',
    "node ~/.claude/team/bin/team.mjs move TESTING --reason 'G1 ok, ajustar RF-02'",
  ]) {
    assert.equal(isStandaloneTeamCall(c), true, c);
    assert.equal(bash(root, c).deny, false, c);
  }
  assert.equal(fs.existsSync(path.join(REPO, 'runtime', 'lib', 'shell.mjs')), false);
});

// ---------------------------------------------------------------- aliases de caminho (revisão, achado 3)

const KEY_NAME = path.basename(KEY_FILE);
const IS_WIN = process.platform === 'win32';

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

test('aliases do revisor para a chave não escapam (\\\\.\\, admin share, \\\\?\\UNC\\, 8.3)', { skip: !IS_WIN }, () => {
  const root = startedProject();
  const aliases = [
    `\\\\.\\${KEY_FILE}`,
    adminShare(KEY_FILE),
    `\\\\?\\UNC\\${adminShare(KEY_FILE).slice(2)}`,
    adminShare(KEY_FILE, '127.0.0.1'),
    adminShare(KEY_FILE, os.hostname()),
    `//./${KEY_FILE.replace(/\\/g, '/')}`,
  ];
  const curto = shortName(TEAM_HOME);
  if (curto !== TEAM_HOME) aliases.push(path.join(curto, KEY_NAME)); // runtime por nome 8.3 real
  for (const alias of aliases) {
    assert.equal(read(root, alias).deny, true, `Read ${alias}`);
    const dir = path.dirname(alias);
    assert.equal(search(root, 'Grep', { pattern: 'x', path: dir }).deny, true, `Grep ${dir}`);
    assert.equal(search(root, 'Glob', { pattern: '**/*', path: dir }).deny, true, `Glob ${dir}`);
  }
  // alias de outro arquivo do runtime continua liberado no Read (CA-03.4)
  assert.equal(read(root, adminShare(path.join(TEAM_HOME, 'bin', 'team.mjs'))).deny, false);
});

test('alias de um ANCESTRAL da chave (sem nome da chave nem do runtime) é bloqueado', { skip: !IS_WIN }, (t) => {
  const root = startedProject();
  // perfil do usuário via compartilhamento administrativo: ancestral da chave de teste (em %TEMP%)
  const perfil = path.dirname(path.dirname(TEAM_HOME)); // ...\AppData\Local
  assert.equal(search(root, 'Grep', { pattern: 'x', path: adminShare(perfil) }).deny, true, adminShare(perfil));
  assert.equal(search(root, 'Glob', { pattern: '**/*', path: `\\\\?\\UNC\\${adminShare(perfil).slice(2)}` }).deny, true);

  // ancestral por nome 8.3 real: runtime em <tmp>\Diretorio Longo Do Claude\team
  const longo = fs.mkdtempSync(path.join(os.tmpdir(), 'at-8dot3-'));
  const ancestral = path.join(longo, 'Diretorio Longo Do Claude');
  fs.mkdirSync(path.join(ancestral, 'team'), { recursive: true });
  const curto = shortName(ancestral);
  const anterior = process.env.AGENT_TEAM_HOME;
  process.env.AGENT_TEAM_HOME = path.join(ancestral, 'team'); // `paths.mjs` relê a variável
  try {
    assert.equal(search(root, 'Grep', { pattern: 'x', path: ancestral }).deny, true);
    if (curto === ancestral) {
      t.diagnostic('o volume do %TEMP% não gera nomes 8.3; a expansão real não foi exercitada aqui');
    } else {
      assert.match(path.basename(curto), /~\d/);
      assert.equal(search(root, 'Grep', { pattern: 'x', path: curto }).deny, true, curto);
      assert.equal(search(root, 'Glob', { pattern: '**/*', path: curto }).deny, true, curto);
      assert.equal(paths.normalizeTarget(root, curto), ancestral); // expandido, não só o nome
    }
  } finally {
    process.env.AGENT_TEAM_HOME = anterior;
  }
});

test('nome 8.3 que não pode ser expandido bloqueia (fail-closed)', { skip: !IS_WIN }, () => {
  const root = startedProject();
  const inventado = path.join(os.tmpdir(), 'NAOEXIS~7', 'sub');
  const res = search(root, 'Grep', { pattern: 'x', path: inventado });
  assert.equal(res.deny, true);
  assert.match(res.reason, /nome curto/);
  assert.match(res.reason, /caminho completo/); // RNF-05: o que fazer
  assert.equal(read(root, path.join(inventado, 'a.txt')).deny, true);
  // nome com ~ e dígito que EXISTE de verdade é só um nome: expande para si mesmo e libera
  const real = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'at-til-')), 'versao~2');
  fs.mkdirSync(real);
  assert.equal(search(root, 'Grep', { pattern: 'x', path: real }).deny, false);
});

test('defesa em profundidade: nome da chave ou do runtime (.claude/team, CLAUDE~N) no alvo nega', () => {
  const root = startedProject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'at-alias-'));
  fs.mkdirSync(path.join(base, 'qualquer', '.claude', 'team', 'lib'), { recursive: true });
  // Read: qualquer arquivo com o nome da chave; outro arquivo com nome de runtime continua liberado
  assert.equal(read(root, path.join(base, 'qualquer', KEY_NAME)).deny, true);
  assert.equal(read(root, path.join(base, 'qualquer', '.claude', 'team', 'bin.mjs')).deny, false);
  // Grep/Glob: alvo com nome do runtime instalado
  for (const alvo of [
    path.join(base, 'qualquer', '.claude', 'team'),
    path.join(base, 'qualquer', '.claude', 'team', 'lib'),
  ]) {
    assert.equal(search(root, 'Grep', { pattern: 'x', path: alvo }).deny, true, alvo);
  }
  assert.equal(paths.isRuntimeAlias(path.join(base, 'CLAUDE~2', 'team')), true);
  assert.equal(paths.isRuntimeAlias(path.join(base, 'CLAUDE~2')), true);
  assert.equal(paths.isRuntimeAlias(path.join(base, 'qualquer')), false);
  // o texto do padrão continua fora da avaliação
  assert.equal(search(root, 'Grep', { pattern: `CLAUDE~2/team/${KEY_NAME}`, path: root }).deny, false);
  // a normalização em si
  assert.equal(paths.stripLongPrefix('\\\\.\\C:\\x'), 'C:\\x');
  assert.equal(paths.stripLongPrefix('\\\\.\\UNC\\srv\\share\\x'), '\\\\srv\\share\\x');
  assert.equal(paths.stripAdminShare('\\\\localhost\\c$\\Users\\x'), 'C:\\Users\\x');
  assert.equal(paths.stripAdminShare('\\\\LOCALHOST\\D$'), 'D:\\');
  assert.equal(paths.stripAdminShare('\\\\outro-servidor\\c$\\x'), '\\\\outro-servidor\\c$\\x');
});

// ---------------------------------------------------------------- import das regras dentro do fail-closed (achado 7)

/** Cópia do runtime num temporário, com um módulo danificado; o repositório não é tocado. */
function brokenRuntime(damage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-runtime-'));
  fs.cpSync(path.join(REPO, 'runtime'), dir, { recursive: true });
  damage(dir);
  return path.join(dir, 'hooks', 'guard.mjs');
}
const runHookAt = (hook, payload) =>
  spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8', env: process.env });

test('módulo ausente ou com erro de sintaxe: bloqueia com time ativo, libera fora', () => {
  const root = startedProject();
  const dentro = { hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' } };
  const fora = { ...dentro, cwd: tmpProject() };
  const casos = {
    'paths.mjs ausente': (d) => fs.rmSync(path.join(d, 'lib', 'paths.mjs')),
    'git.mjs com erro de sintaxe': (d) => fs.writeFileSync(path.join(d, 'lib', 'git.mjs'), 'export const = ;\n'),
    'guard-rules.mjs ausente': (d) => fs.rmSync(path.join(d, 'lib', 'guard-rules.mjs')),
  };
  for (const [nome, damage] of Object.entries(casos)) {
    const hook = brokenRuntime(damage);
    const res = runHookAt(hook, dentro);
    assert.equal(res.status, 2, `${nome}: ${res.stderr}`);
    assert.match(res.stderr, /^\[agent-team\] BLOQUEADO: erro interno do guard ao avaliar Bash/, nome);
    assert.match(res.stderr, /enforce: false/, nome);
    assert.equal(/\n\s+at /.test(res.stderr), false, nome);
    assert.equal(runHookAt(hook, fora).status, 0, `${nome} (fora)`);
    editConfig(root, (c) => {
      c.enforce = false;
    });
    assert.equal(runHookAt(hook, dentro).status, 0, `${nome} (enforce=false)`);
    editConfig(root, (c) => {
      c.enforce = true;
    });
  }
});

