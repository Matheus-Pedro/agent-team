// Comparação estrutural de caminhos para as regras de busca do guard (ADR-003).
//
// Duas decisões deliberadas:
//   1. usa `node:path` **da plataforma** (nunca `path.posix`, nunca `toLowerCase`
//      manual): é `path.relative` que dá a semântica de caixa correta em cada
//      sistema (no Windows compara sem diferenciar caixa; no POSIX diferencia);
//   2. é lexical no caminho comum — nenhuma chamada de `fs`, custo próximo de zero
//      (RNF-03). A única exceção é o nome curto 8.3 do Windows (`CLAUDE~2`), que só
//      o sistema de arquivos sabe expandir: aí, e só aí, há um `realpath`.
//      Link simbólico e junction **não** são resolvidos (limite do ADR-003).
//
// Aliases do mesmo arquivo no Windows tratados aqui: `\\?\`, `\\.\`, `\\?\UNC\`,
// `\\.\UNC\`, compartilhamento administrativo local (`\\localhost\c$\...`) e 8.3.
// Defesa em profundidade: `isKeyAlias`/`isRuntimeAlias` negam pelo **nome** no alvo
// normalizado, para o caso de sobrar um alias que a normalização não conheça.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEAM_HOME, KEY_FILE } from './core.mjs';

const DEVICE_PREFIX_RE = /^[\\/]{2}[?.][\\/]/; // \\?\ e \\.\ (também com /)
const UNC_AFTER_PREFIX_RE = /^UNC[\\/]/i;

/**
 * Remove o prefixo de dispositivo do Windows: `\\?\C:\x` e `\\.\C:\x` → `C:\x`;
 * `\\?\UNC\srv\share` e `\\.\UNC\srv\share` → `\\srv\share`.
 */
export function stripLongPrefix(p) {
  const s = String(p ?? '');
  if (!DEVICE_PREFIX_RE.test(s)) return s;
  const rest = s.slice(4);
  return UNC_AFTER_PREFIX_RE.test(rest) ? `\\\\${rest.slice(4)}` : rest;
}

let localHosts;
function isLocalHost(host) {
  if (!localHosts) {
    localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0--1.ipv6-literal.net', '.']);
    try {
      localHosts.add(os.hostname().toLowerCase());
    } catch {
      /* sem hostname: fica só com os literais */
    }
  }
  return localHosts.has(String(host).toLowerCase());
}

/** `\\localhost\c$\Users\x` → `C:\Users\x` (compartilhamento administrativo da própria máquina). */
export function stripAdminShare(p) {
  const m = /^[\\/]{2}([^\\/]+)[\\/]([a-z])\$(?=[\\/]|$)(.*)$/i.exec(String(p ?? ''));
  if (!m || !isLocalHost(m[1])) return String(p ?? '');
  return `${m[2].toUpperCase()}:${m[3] ? m[3] : '\\'}`;
}

const SHORT_NAME_RE = /~\d/;
const unresolved = new Set();

/**
 * Expande nomes curtos 8.3 (`C:\Users\x\CLAUDE~2\team`) pelo sistema de arquivos.
 * Só roda quando algum segmento tem `~<dígito>`. Se o caminho não existe inteiro,
 * expande o maior ancestral existente e recoloca o resto — desde que o resto não
 * tenha mais nenhum segmento 8.3. Se tiver (não dá para saber aonde o alias leva),
 * o alvo fica marcado como **não resolvido** e o guard bloqueia (fail-closed).
 * Nunca lança.
 */
function expandShortNames(p) {
  if (process.platform !== 'win32' || !SHORT_NAME_RE.test(p)) return p;
  let head = p;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = stripLongPrefix(fs.realpathSync.native(head));
      if (tail.some((s) => SHORT_NAME_RE.test(s))) break;
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) break;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
  unresolved.add(p);
  return p;
}

/** O alvo tem nome curto 8.3 que não pôde ser expandido? O guard deve bloquear. */
export function isUnresolvedAlias(target) {
  return Boolean(target) && unresolved.has(target);
}

const canonical = (p) => stripAdminShare(stripLongPrefix(p));

/**
 * Caminho absoluto e normalizado do alvo, ou `null` quando não há alvo.
 * Nunca lança: entrada estranha vira `null` e a regra simplesmente não se aplica.
 */
export function normalizeTarget(cwd, p) {
  const raw = canonical(p);
  if (!raw) return null;
  try {
    return expandShortNames(canonical(path.resolve(canonical(cwd || process.cwd()), raw)));
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
  return expandShortNames(canonical(env ? path.resolve(env) : TEAM_HOME));
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

// ---------- defesa em profundidade (por nome, no alvo já normalizado) ----------

const segmentsOf = (p) => String(p ?? '').split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
const CLAUDE_DIR_RE = /^(\.claude|claude~\d+)$/;
const CLAUDE_SHORT_RE = /^claude~\d+$/;

/** O alvo tem o nome do arquivo da chave, em qualquer diretório? */
export function isKeyAlias(target) {
  if (!target) return false;
  const segs = segmentsOf(target);
  return segs.length > 0 && segs[segs.length - 1] === path.basename(KEY_FILE).toLowerCase();
}

/**
 * O alvo parece ser o runtime instalado (ou algo dentro dele) por outro nome?
 * Segmento `.claude` ou 8.3 `CLAUDE~N` seguido de `team`; ou o próprio `CLAUDE~N`
 * (ancestral da chave por nome curto). O **texto do padrão** nunca passa por aqui.
 */
export function isRuntimeAlias(target) {
  if (!target) return false;
  const segs = segmentsOf(target);
  for (let i = 0; i < segs.length; i++) {
    if (CLAUDE_DIR_RE.test(segs[i]) && segs[i + 1] === 'team') return true;
  }
  return segs.length > 0 && CLAUDE_SHORT_RE.test(segs[segs.length - 1]);
}
