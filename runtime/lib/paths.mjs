// Comparação estrutural de caminhos para as regras de busca do guard (ADR-003).
//
// Duas decisões deliberadas:
//   1. usa `node:path` **da plataforma** (nunca `path.posix`, nunca `toLowerCase`
//      manual): é `path.relative` que dá a semântica de caixa correta em cada
//      sistema (no Windows compara sem diferenciar caixa; no POSIX diferencia);
//   2. é puramente lexical — nenhuma chamada de `fs`. Custo próximo de zero no
//      caminho comum (RNF-03), mas link simbólico e junction **não** são
//      resolvidos (limite registrado no ADR-003).

import path from 'node:path';
import { TEAM_HOME, KEY_FILE } from './core.mjs';

/** Remove o prefixo longo do Windows: `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\share` → `\\srv\share`. */
export function stripLongPrefix(p) {
  const s = String(p ?? '');
  if (!s.startsWith('\\\\?\\')) return s;
  const rest = s.slice(4);
  return /^UNC\\/i.test(rest) ? `\\\\${rest.slice(4)}` : rest;
}

/**
 * Caminho absoluto e normalizado do alvo, ou `null` quando não há alvo.
 * Nunca lança: entrada estranha vira `null` e a regra simplesmente não se aplica.
 */
export function normalizeTarget(cwd, p) {
  const raw = stripLongPrefix(p);
  if (!raw) return null;
  try {
    return stripLongPrefix(path.resolve(stripLongPrefix(cwd || process.cwd()), raw));
  } catch {
    return null;
  }
}

/** `true` quando os dois caminhos são o mesmo, com a semântica de caixa da plataforma. */
export function samePath(a, b) {
  if (!a || !b) return false;
  try {
    return path.relative(a, b) === '';
  } catch {
    return false;
  }
}

/** `true` quando `child` está estritamente dentro de `parent` (sem armadilha de prefixo). */
export function isInside(parent, child) {
  if (!parent || !child) return false;
  let rel;
  try {
    rel = path.relative(parent, child);
  } catch {
    return false;
  }
  if (rel === '' || path.isAbsolute(rel)) return false;
  // `..` sobe; `..foo` é um nome de diretório legítimo e continua dentro.
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../'));
}

/** `true` quando `target` é o próprio `file` ou um diretório ancestral dele. */
export function isSameOrAncestor(target, file) {
  return samePath(target, file) || isInside(target, file);
}

const GLOB_META_RE = /[*?[\]{}]/;

/**
 * Prefixo literal de diretório antes do 1º metacaractere de glob (`* ? [ ] { }`).
 * `C:/u/.claude/team/**` → `C:/u/.claude/team` · `src/**\/*.ts` → `src` · `README.md` → `README.md`.
 */
export function staticPrefix(globPattern) {
  const s = String(globPattern ?? '');
  if (!s) return '';
  const m = GLOB_META_RE.exec(s);
  if (!m) return s;
  const head = s.slice(0, m.index);
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'));
  if (cut < 0) return '';
  const dir = head.slice(0, cut);
  const withSep = head.slice(0, cut + 1);
  // Mantém o separador quando cortá-lo mudaria a natureza do caminho:
  // `/**` → `/` e `C:/**` → `C:/` (sem a barra, `C:` é relativo à unidade).
  if (!dir || path.isAbsolute(dir) !== path.isAbsolute(withSep)) return withSep;
  return dir;
}

/**
 * O prefixo estático de um padrão só é alvo quando é absoluto ou começa com `..`
 * (ADR-003): assim `Glob('C:/u/.claude/team/**')` é avaliado, e um padrão de
 * texto como `\.claude/team` — relativo — é descartado, sem falso positivo.
 */
export function patternTarget(cwd, pattern) {
  const prefix = staticPrefix(pattern);
  if (!prefix) return null;
  const upward = prefix === '..' || prefix.startsWith('../') || prefix.startsWith('..\\');
  if (!path.isAbsolute(prefix) && !upward) return null;
  const target = normalizeTarget(cwd, prefix);
  // Um padrão **sem** metacaractere de glob que resolve para a raiz do volume
  // (`Grep(pattern: '/')`) é texto de busca, não alvo: seria falso positivo.
  // Com metacaractere (`Glob('C:/**')`) o alvo é real e continua valendo.
  if (target && !GLOB_META_RE.test(String(pattern)) && path.dirname(target) === target) return null;
  return target;
}

// ---------- runtime instalado e chave ----------

/*
 * `core.TEAM_HOME`/`core.KEY_FILE` são resolvidos no carregamento do módulo. Estas
 * duas funções releem `AGENT_TEAM_HOME` a cada chamada para que um teste que troque
 * a variável depois do import continue enxergando o diretório certo. Sem a variável,
 * o resultado é exatamente o de `core`.
 */

/** Diretório do runtime instalado (`~/.claude/team`, ou `AGENT_TEAM_HOME`). */
export function teamHomeDir() {
  const env = process.env.AGENT_TEAM_HOME;
  return stripLongPrefix(env ? path.resolve(env) : TEAM_HOME);
}

/** Arquivo da chave de assinatura das aprovações. Nome fixado pelo ADR-007. */
export function keyFilePath() {
  return path.join(teamHomeDir(), path.basename(KEY_FILE));
}

/**
 * O alvo alcança a chave de assinatura? Verdadeiro quando o alvo é a chave, é um
 * diretório ancestral dela (inclusive o runtime instalado, `~/.claude`, `~` e a
 * raiz do volume) ou está dentro do runtime instalado (CA-03.3).
 */
export function reachesKey(target) {
  if (!target) return false;
  return isSameOrAncestor(target, keyFilePath()) || isSameOrAncestor(teamHomeDir(), target);
}
