// Único módulo do runtime que executa `git` (ADR-001). Só leitura: nenhuma função
// daqui altera repositório. Nenhuma exceção vaza — erro vira estado (`unknown` ou
// `no-repo`). Contrato: docs/architecture/contracts.md §1.
//
// Custo (RNF-03): `resolveBranch` gasta no máximo 1 execução de git; `hasBaseCommit`
// é preguiçosa (só quando o guard já vai bloquear ou quando o CLI monta o status).
// As duas memoizam por `cwd` no escopo do módulo.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 3000;
const MAX_DEPTH = 64;

// ---------- detecção de repositório (só fs, sem spawn) ----------

/** Sobe a partir de `start` procurando `.git` (diretório ou arquivo, no caso de worktree). */
export function findGitRoot(start) {
  if (!start) return null;
  let dir = path.resolve(start);
  for (let i = 0; i < MAX_DEPTH; i++) {
    try {
      const st = fs.statSync(path.join(dir, '.git'));
      if (st.isDirectory() || st.isFile()) return dir;
    } catch {
      /* continua subindo */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ---------- execução de git ----------

/**
 * Executa git e devolve `{ status, stdout }`. `status: null` significa que o
 * processo não chegou a rodar (git ausente, timeout) e vem com `detail`.
 * Nunca lança. `detail` nunca inclui caminho absoluto nem a mensagem do git.
 */
function runGit(cwd, args) {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Sem `windowsHide`: fora do contrato §1 e custa ~10 ms por spawn no Windows (RNF-03).
    });
    return { status: 0, stdout: String(stdout ?? '') };
  } catch (err) {
    if (typeof err?.status === 'number') return { status: err.status, stdout: String(err.stdout ?? '') };
    return { status: null, stdout: '', detail: spawnFailureDetail(err) };
  }
}

function spawnFailureDetail(err) {
  const code = err?.code;
  if (code === 'ENOENT') return 'git não encontrado no PATH';
  if (code === 'ETIMEDOUT' || err?.killed || err?.signal) return 'tempo esgotado ao executar git';
  if (code === 'EACCES' || code === 'EPERM') return 'sem permissão para executar git';
  return `falha ao executar git (${code || 'erro desconhecido'})`;
}

// ---------- memoização ----------

const branchCache = new Map();
const baseCommitCache = new Map();

const cacheKey = (cwd) => path.resolve(cwd || '.');

/** Esquece o que foi memoizado. Só é necessário em teste: o guard e o CLI são processos curtos. */
export function resetGitCache() {
  branchCache.clear();
  baseCommitCache.clear();
}

// ---------- branch atual ----------

/**
 * Resolve a branch atual em, no máximo, 1 execução de git.
 * @returns {{kind:'branch'|'detached'|'no-repo'|'unknown', name: string|null, detail?: string}}
 */
export function resolveBranch(cwd) {
  const key = cacheKey(cwd);
  if (!branchCache.has(key)) branchCache.set(key, computeBranch(key));
  return branchCache.get(key);
}

function computeBranch(dir) {
  if (!findGitRoot(dir)) return { kind: 'no-repo', name: null };
  const r = runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (r.status === 0) {
    const name = r.stdout.trim();
    // Funciona também em branch sem commits (unborn): o git devolve o nome com exit 0.
    if (name) return { kind: 'branch', name };
    return { kind: 'unknown', name: null, detail: 'git devolveu uma branch vazia' };
  }
  if (r.status === 1) return { kind: 'detached', name: null }; // HEAD destacado (verificado)
  if (r.status === null) return { kind: 'unknown', name: null, detail: r.detail };
  return { kind: 'unknown', name: null, detail: `git saiu com status ${r.status}` };
}

/**
 * Normaliza o valor injetado em testes/chamadores antigos: `string → {kind:'branch', name}`,
 * `null → {kind:'unknown'}` (ADR-001, compatibilidade de teste).
 */
export function normalizeBranchInfo(value) {
  if (typeof value === 'string' && value.trim()) return { kind: 'branch', name: value.trim() };
  if (value && typeof value === 'object' && typeof value.kind === 'string') {
    return { name: null, ...value };
  }
  return { kind: 'unknown', name: null, detail: 'branch não informada' };
}

// ---------- commit base ----------

/**
 * O repositório já tem o commit base (HEAD resolve para um commit)?
 * @returns {boolean|null} `null` = indeterminado (sem repositório ou falha do git).
 */
export function hasBaseCommit(cwd) {
  const key = cacheKey(cwd);
  if (!baseCommitCache.has(key)) baseCommitCache.set(key, computeBaseCommit(key));
  return baseCommitCache.get(key);
}

function computeBaseCommit(dir) {
  if (!findGitRoot(dir)) return null;
  const r = runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

// ---------- mensagens (contrato §1, texto normativo) ----------
//
// As duas frases são lidas pelo usuário (via CLI) e pelo agente (via mensagem de
// bloqueio do guard). Por isso nenhuma delas fala na segunda pessoa: um "crie o
// commit" lido pelo agente o convidaria a commitar na principal, que é justamente
// o que a regra central proíbe.

/** Frase do commit base, reaproveitada pelo guard na mensagem de bloqueio (CA-01.1). */
export function missingBaseCommitMessage(branch) {
  return (
    `Este repositório ainda não tem o commit base em ${branch}. O commit base tem de ser criado pelo ` +
    'usuário, no terminal dele (agentes não commitam na principal), antes de IMPLEMENTING; depois o ' +
    'Orchestrator cria a branch do work item a partir dele.'
  );
}

/** Frase da branch indeterminada (CA-01.2). */
export function unknownBranchMessage(detail) {
  return (
    `Não foi possível identificar a branch atual (${detail || 'motivo desconhecido'}). ` +
    'Comandos que alteram histórico ficam bloqueados até isso ser resolvido; peça ao usuário para ' +
    'verificar o repositório.'
  );
}

/**
 * Avisos de git para o CLI (`team status`, `team init`). No máximo uma frase por
 * situação; lista vazia quando não há nada a avisar. Sem git, nunca avisa (CA-01.6).
 */
export function gitWarnings(cwd, mainBranches) {
  const info = resolveBranch(cwd);
  if (info.kind === 'no-repo' || info.kind === 'detached') return [];
  if (info.kind === 'unknown') return [unknownBranchMessage(info.detail)];
  const mains = Array.isArray(mainBranches) ? mainBranches : [];
  if (!mains.includes(info.name)) return [];
  if (hasBaseCommit(cwd) === false) return [missingBaseCommitMessage(info.name)];
  return [];
}
