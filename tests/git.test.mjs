// Testes de runtime/lib/git.mjs (ADR-001 / contracts.md §1).
// Todo cenário usa repositório temporário criado aqui — nunca este repositório.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const git = await import('../runtime/lib/git.mjs');
const {
  findGitRoot,
  resolveBranch,
  hasBaseCommit,
  gitWarnings,
  resetGitCache,
  normalizeBranchInfo,
} = git;

const MAINS = ['main', 'master'];
const created = [];

after(() => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* lixo em tmp não falha o teste */
    }
  }
});

function tmpDir({ spaces = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-git-'));
  created.push(base);
  if (!spaces) return base;
  const dir = path.join(base, 'projeto com espaço');
  fs.mkdirSync(dir);
  return dir;
}

function run(cwd, args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 20000 });
}

/**
 * Cria um repositório temporário. `branch` é definida via symbolic-ref para não
 * depender de init.defaultBranch nem da versão do git.
 */
function tmpRepo({ branch = 'main', commit = false, spaces = false } = {}) {
  const dir = tmpDir({ spaces });
  execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore', timeout: 20000 });
  run(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  if (commit) {
    run(dir, [
      '-c', 'user.name=teste',
      '-c', 'user.email=teste@exemplo.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '--quiet', '-m', 'commit base',
    ]);
  }
  return dir;
}

/** Roda `fn` sem git no PATH, para exercitar a falha de spawn. */
function withoutGit(fn) {
  const path0 = process.env.PATH;
  const pathext0 = process.env.PATHEXT;
  process.env.PATH = '';
  process.env.PATHEXT = '';
  try {
    return fn();
  } finally {
    process.env.PATH = path0;
    if (pathext0 === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = pathext0;
  }
}

// ---------- findGitRoot ----------

test('findGitRoot sobe até o .git (diretório ou arquivo) e devolve null fora de repositório', () => {
  const repo = tmpRepo();
  const deep = path.join(repo, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findGitRoot(deep), repo);
  assert.equal(findGitRoot(repo), repo);

  // worktree: .git é um arquivo com `gitdir: ...`
  const wt = tmpDir();
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(findGitRoot(wt), wt);

  assert.equal(findGitRoot(tmpDir()), null);
  assert.equal(findGitRoot(''), null);
  assert.equal(findGitRoot(undefined), null);
});

// ---------- os quatro kinds ----------

test('repositório sem commits: branch reconhecida, sem commit base e com aviso (CA-01.1, CA-01.3)', () => {
  const repo = tmpRepo({ branch: 'main' });
  assert.deepEqual(resolveBranch(repo), { kind: 'branch', name: 'main' });
  assert.equal(hasBaseCommit(repo), false);
  const warnings = gitWarnings(repo, MAINS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ainda não tem o commit base em main/);
  assert.match(warnings[0], /no seu terminal/);
  assert.match(warnings[0], /antes de IMPLEMENTING/);
});

test('repositório com commits na principal: sem aviso (CA-01.5)', () => {
  const repo = tmpRepo({ branch: 'main', commit: true });
  assert.deepEqual(resolveBranch(repo), { kind: 'branch', name: 'main' });
  assert.equal(hasBaseCommit(repo), true);
  assert.deepEqual(gitWarnings(repo, MAINS), []);
});

test('branch fora das principais não gera aviso, mesmo sem commit base', () => {
  const comCommit = tmpRepo({ branch: 'team/w-001-exemplo', commit: true });
  assert.deepEqual(resolveBranch(comCommit), { kind: 'branch', name: 'team/w-001-exemplo' });
  assert.deepEqual(gitWarnings(comCommit, MAINS), []);

  const semCommit = tmpRepo({ branch: 'feature/x' });
  assert.equal(hasBaseCommit(semCommit), false);
  assert.deepEqual(gitWarnings(semCommit, MAINS), []);
});

test('HEAD destacado é distinguido de branch e não gera aviso (CA-01.7)', () => {
  const repo = tmpRepo({ branch: 'main', commit: true });
  run(repo, ['checkout', '--quiet', '--detach', 'HEAD']);
  assert.deepEqual(resolveBranch(repo), { kind: 'detached', name: null });
  assert.equal(hasBaseCommit(repo), true);
  assert.deepEqual(gitWarnings(repo, MAINS), []);
});

test('fora de repositório: no-repo, indeterminado e nenhum aviso (CA-01.6)', () => {
  const dir = tmpDir();
  assert.deepEqual(resolveBranch(dir), { kind: 'no-repo', name: null });
  assert.equal(hasBaseCommit(dir), null);
  assert.deepEqual(gitWarnings(dir, MAINS), []);
});

test('fora de repositório nada é executado: decide sem git no PATH', () => {
  const dir = tmpDir();
  withoutGit(() => {
    assert.deepEqual(resolveBranch(dir), { kind: 'no-repo', name: null });
    assert.equal(hasBaseCommit(dir), null);
    assert.deepEqual(gitWarnings(dir, MAINS), []);
  });
});

test('git ausente do PATH vira unknown com motivo, sem lançar (CA-01.2)', () => {
  const repo = tmpRepo({ branch: 'main', commit: true });
  const info = withoutGit(() => resolveBranch(repo));
  assert.equal(info.kind, 'unknown');
  assert.equal(info.name, null);
  assert.match(info.detail, /git não encontrado no PATH/);
  assert.equal(withoutGit(() => hasBaseCommit(repo)), null);

  const warnings = withoutGit(() => gitWarnings(repo, MAINS));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Não foi possível identificar a branch atual \(git não encontrado no PATH\)\./);
  assert.match(warnings[0], /alteram histórico serão bloqueados/);
});

test('repositório ilegível vira unknown com o status do git, sem lançar', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.git'), 'conteúdo inválido\n');
  assert.equal(findGitRoot(dir), dir);
  const info = resolveBranch(dir);
  assert.equal(info.kind, 'unknown');
  assert.match(info.detail, /git saiu com status \d+/);
  assert.equal(hasBaseCommit(dir), null);
  assert.equal(gitWarnings(dir, MAINS).length, 1);
});

// ---------- detalhes de plataforma e de contrato ----------

test('caminho com espaços funciona (Windows)', () => {
  const repo = tmpRepo({ branch: 'main', commit: true, spaces: true });
  assert.ok(repo.includes(' '));
  assert.deepEqual(resolveBranch(repo), { kind: 'branch', name: 'main' });
  assert.equal(hasBaseCommit(repo), true);
});

test('subdiretório do repositório resolve a mesma branch', () => {
  const repo = tmpRepo({ branch: 'main', commit: true });
  const sub = path.join(repo, 'src', 'lib');
  fs.mkdirSync(sub, { recursive: true });
  assert.deepEqual(resolveBranch(sub), { kind: 'branch', name: 'main' });
  assert.equal(hasBaseCommit(sub), true);
});

test('memoização por cwd: só recalcula depois de resetGitCache', () => {
  const repo = tmpRepo({ branch: 'main' });
  const first = resolveBranch(repo);
  assert.equal(resolveBranch(repo), first, 'mesma referência = resultado memoizado');
  assert.equal(hasBaseCommit(repo), false);

  run(repo, [
    '-c', 'user.name=teste',
    '-c', 'user.email=teste@exemplo.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '--quiet', '-m', 'commit base',
  ]);
  assert.equal(hasBaseCommit(repo), false, 'valor memoizado não muda no mesmo processo');
  resetGitCache();
  assert.equal(hasBaseCommit(repo), true);
  assert.deepEqual(gitWarnings(repo, MAINS), []);
});

test('gitWarnings tolera mainBranches ausente ou inválido', () => {
  const repo = tmpRepo({ branch: 'main' });
  assert.deepEqual(gitWarnings(repo), []);
  assert.deepEqual(gitWarnings(repo, null), []);
  assert.deepEqual(gitWarnings(repo, 'main'), []);
});

test('normalizeBranchInfo converte string e null (compatibilidade do ADR-001)', () => {
  assert.deepEqual(normalizeBranchInfo('main'), { kind: 'branch', name: 'main' });
  assert.deepEqual(normalizeBranchInfo(' team/x '), { kind: 'branch', name: 'team/x' });
  assert.equal(normalizeBranchInfo(null).kind, 'unknown');
  assert.equal(normalizeBranchInfo('').kind, 'unknown');
  assert.equal(normalizeBranchInfo(undefined).kind, 'unknown');
  assert.deepEqual(normalizeBranchInfo({ kind: 'detached' }), { kind: 'detached', name: null });
  const info = { kind: 'branch', name: 'main' };
  assert.deepEqual(normalizeBranchInfo(info), info);
});

test('nenhuma mensagem expõe caminho absoluto do repositório', () => {
  const repo = tmpRepo({ branch: 'main' });
  const todas = [...gitWarnings(repo, MAINS), ...withoutGit(() => {
    resetGitCache();
    return gitWarnings(repo, MAINS);
  })];
  resetGitCache();
  for (const msg of todas) assert.ok(!msg.includes(repo), msg);
});

test('as funções não alteram o repositório', () => {
  const repo = tmpRepo({ branch: 'main', commit: true });
  const antes = execFileSync('git', ['-C', repo, 'status', '--porcelain=v2', '--branch'], { encoding: 'utf8' });
  resolveBranch(repo);
  hasBaseCommit(repo);
  gitWarnings(repo, MAINS);
  const depois = execFileSync('git', ['-C', repo, 'status', '--porcelain=v2', '--branch'], { encoding: 'utf8' });
  assert.equal(depois, antes);
});
