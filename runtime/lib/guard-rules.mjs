// Regras do hook PreToolUse. Só valem dentro de projetos com .team/config.json.
// Objetivo: impedir que o modelo avance sem aprovação humana (merge, deploy,
// edição do estado/aprovações). É uma barreira contra erro e alucinação do
// modelo — não é um sandbox contra alguém tentando burlar deliberadamente.
//
// Este módulo não executa git: quem fala com o git é `lib/git.mjs` (ADR-001).

import path from 'node:path';
import {
  findTeamRoot,
  loadConfig,
  loadState,
  defaultConfig,
  checkApproval,
  gateEnabled,
} from './core.mjs';
import {
  resolveBranch,
  normalizeBranchInfo,
  hasBaseCommit,
  missingBaseCommitMessage,
  unknownBranchMessage,
} from './git.mjs';
import {
  normalizeTarget,
  patternTarget,
  samePath,
  reachesKey,
  keyFilePath,
  isKeyAlias,
  isRuntimeAlias,
  isUnresolvedAlias,
} from './paths.mjs';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

const slash = (s) => String(s || '').replace(/\\/g, '/');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TEAM_CLI_RE =
  /^\s*node(?:\.exe)?\s+(?:"[^"]*\.claude\/team\/bin\/team\.mjs"|'[^']*\.claude\/team\/bin\/team\.mjs'|[^\s"']*\.claude\/team\/bin\/team\.mjs)(?:\s|$)/i;

// Regra estrita da v1.0: qualquer metacaractere de shell, **dentro ou fora de aspas**,
// invalida a chamada isolada. A US-07 (aspas liberando metacaractere, ADR-009) saiu da
// v1.1: as regras de citação divergem entre PowerShell e bash (`\"`, aspas tipográficas,
// `$'...'`), e um scanner que erre para o lado permissivo libera o comando inteiro.
const SHELL_META_RE = /[;&|<>`\r\n]|\$\(/;

/** Lista branca do CLI do time: só a chamada isolada, sem nenhum metacaractere. */
export function isStandaloneTeamCall(command) {
  return TEAM_CLI_RE.test(slash(command)) && !SHELL_META_RE.test(command);
}

export function protectedFileReason(filePath, cwd) {
  if (!filePath) return null;
  const n = '/' + slash(path.resolve(cwd || '.', filePath)).toLowerCase();
  if (/\/\.team\/approvals(\/|$)/.test(n)) return 'aprovações só podem ser registradas pelo usuário (APROVAR Gx no chat)';
  if (/\/\.team\/logs(\/|$)/.test(n)) return 'o log de auditoria só é escrito pelo runtime';
  if (/\/\.team\/state\.json$/.test(n)) return 'o estado só muda via CLI `team` (team move / team task ...)';
  if (/\/\.team\/config\.json$/.test(n)) return 'a config do time (gates) só pode ser alterada manualmente pelo usuário';
  if (/\/\.claude\/team(\/|$)/.test(n)) return 'o runtime do time é instalado pelo repositório agent-team, não editado pelo agente';
  if (/\/\.claude\/settings(\.local)?\.json$/.test(n)) return 'hooks e permissões só podem ser alterados pelo usuário enquanto o time está ativo';
  return null;
}

const WRITE_VERBS_RE =
  /(>|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\brm\b|\bset-content\b|\badd-content\b|\bout-file\b|\bcopy-item\b|\bmove-item\b|\bremove-item\b|\bnew-item\b|\bwritefile)/i;
const DELETE_VERBS_RE =
  /(\brm\b|\brmdir\b|\bdel\b|\berase\b|\brd\b|\bmv\b|\bren(ame)?\b|\bremove-item\b|\bmove-item\b|\brename-item\b|\bunlink\b|\brmsync\b)/i;

// Alternativa nativa, exigida pelo RNF-05/CA-03.5: o bloqueio de shell por literal
// continua conservador (Q-05), então a mensagem tem de dizer o que fazer em vez dele.
const USE_SEARCH_TOOLS = 'Para pesquisar o código, use as ferramentas Grep ou Glob com o alvo dentro do projeto.';

export function shellPathReason(command) {
  const n = slash(command).toLowerCase();
  if (n.includes(path.basename(keyFilePath()).toLowerCase())) {
    return `a chave de assinatura das aprovações não pode ser acessada. ${USE_SEARCH_TOOLS}`;
  }
  if (/\.claude\/team(\/|\b)/.test(n)) {
    return (
      'o runtime do time só pode ser usado como comando isolado: node "$HOME/.claude/team/bin/team.mjs" <args> ' +
      '(sem ;, &, |, <, >, `, $( nem quebra de linha, nem mesmo entre aspas). Para ler ou pesquisar o código do runtime, use Read, Grep ou Glob ' +
      '(o alvo não pode ser o diretório do runtime instalado).'
    );
  }
  if (/\.team\/(approvals|logs)\b/.test(n)) {
    return 'aprovações e logs não podem ser manipulados via shell — para consultar, use `team status` ou a ferramenta Read';
  }
  if (/\.team\/(state|config)\.json/.test(n)) return 'estado/config do time não podem ser manipulados via shell — use o CLI `team` (leitura: ferramenta Read)';
  if (/(^|[\s"'=/])\.team(\/|[\s"']|$)/.test(n) && DELETE_VERBS_RE.test(n)) return 'o diretório .team não pode ser removido ou movido pelo agente';
  if (/\bgit\s+clean\b[^;&|]*\s-[a-z]*x/i.test(command)) return '`git clean -x/-X` apagaria o .team/ (ignorado pelo git)';
  if (/\.claude\/settings(\.local)?\.json/.test(n) && WRITE_VERBS_RE.test(n)) return 'hooks e permissões só podem ser alterados pelo usuário';
  return null;
}

// ---------- git (ADR-001) ----------

/**
 * Classifica o comando **só pelo texto**, sem consultar o git.
 * @returns {{historyAltering: boolean, targetsMain: boolean, label: string}|null}
 *   `targetsMain: true` = o comando alcança a principal independentemente da
 *   branch atual; `false` = só importa se a branch atual for a principal.
 */
export function classifyGitCommand(command, mainBranches) {
  const n = slash(command);
  const mains = (mainBranches?.length ? mainBranches : ['main', 'master']);
  const alt = mains.map(escapeRe).join('|');
  const end = String.raw`(?=$|[\s;&|)"'])`;
  const switchesToMain = new RegExp(String.raw`\bgit\s+(checkout|switch)\s+(${alt})${end}`).test(n);
  // Uma linha pode conter mais de um verbo (`git merge x && git push origin main`):
  // reúne todos os candidatos, na ordem da v1.0, e o que alcança a principal
  // independentemente da branch atual tem precedência.
  const found = [];
  const add = (targetsMain, label) => found.push({ historyAltering: true, targetsMain, label });

  if (/\bgh\s+pr\s+merge\b/.test(n)) add(true, 'gh pr merge');
  if (/\bgit\s+merge\b/.test(n)) add(switchesToMain, 'merge na branch principal');
  if (/\bgit\s+(commit|cherry-pick|revert|am|rebase)\b/.test(n)) {
    add(switchesToMain, 'alteração de histórico na branch principal');
  }
  if (/\bgit\s+push\b/.test(n)) {
    if (new RegExp(String.raw`\bgit\s+push\b[^;&|]*[\s:+](${alt})${end}`).test(n)) {
      add(true, 'push para a branch principal');
    } else {
      add(switchesToMain, 'push a partir da branch principal');
    }
  }
  if (new RegExp(String.raw`\bgit\s+(update-ref\s+refs/heads/|branch\s+(-f|--force|-M|-D)\s+)(${alt})${end}`).test(n)) {
    add(true, 'alteração direta da branch principal');
  }
  if (!found.length) return null;
  return found.find((a) => a.targetsMain) || found[0];
}

/** Mantida por compatibilidade: combina a classificação com uma branch em string. */
export function detectMerge(command, branch, mainBranches) {
  const action = classifyGitCommand(command, mainBranches);
  if (!action) return null;
  const mains = mainBranches?.length ? mainBranches : ['main', 'master'];
  return action.targetsMain || (branch && mains.includes(branch)) ? action.label : null;
}

export function detectDeploy(command, deployCfg) {
  const n = slash(command);
  const test = (list) => (list || []).some((p) => {
    try {
      return new RegExp(p, 'i').test(n);
    } catch {
      return false;
    }
  });
  if (!test(deployCfg.patterns)) return null;
  return { production: test(deployCfg.production_patterns) };
}

// ---------- buscas (ADR-003) ----------

/**
 * Alvos que a chamada realmente alcança. O **texto** de `pattern`, `glob` e `type`
 * nunca é inspecionado: só o prefixo estático absoluto (ou que começa com `..`).
 * @returns {string[]} caminhos absolutos normalizados
 */
export function searchTargets(toolName, toolInput = {}, cwd) {
  return searchTargetEntries(toolName, toolInput, cwd).map((e) => e.target);
}

/**
 * Como `searchTargets`, marcando o alvo que vem do prefixo de uma **regex** (`pattern`
 * do Grep). Esse alvo passa só pela comparação estrutural: a rede por nome
 * (`isKeyAlias`/`isRuntimeAlias`) nele seria falso positivo — no Windows a regex
 * `\.claude/team` vira o "caminho" `C:\.claude\team`.
 */
function searchTargetEntries(toolName, toolInput = {}, cwd) {
  const entries = [];
  const add = (target, fromRegex = false) => {
    if (target) entries.push({ target, fromRegex });
  };
  if (toolName === 'Read') {
    add(normalizeTarget(cwd, toolInput.file_path || toolInput.notebook_path || toolInput.path));
    return entries;
  }
  if (!SEARCH_TOOLS.has(toolName)) return entries;
  add(normalizeTarget(cwd, toolInput.path || cwd));
  add(patternTarget(cwd, toolInput.pattern), toolName === 'Grep');
  if (toolName === 'Grep') add(patternTarget(cwd, toolInput.glob));
  return entries;
}

const SEARCH_TARGET_REASON =
  'busca cujo alvo alcança a chave de assinatura das aprovações não é permitida; ' +
  'restrinja o alvo ao diretório do projeto (o padrão da busca pode citar qualquer texto).';
const UNRESOLVED_ALIAS_REASON =
  'o alvo usa um nome curto do Windows (8.3, com ~ e dígito) que não pôde ser resolvido, então não dá para saber se ele ' +
  'alcança a chave de assinatura das aprovações. Repita a chamada com o caminho completo, sem nomes curtos.';
const KEY_READ_REASON =
  'a chave de assinatura das aprovações não pode ser lida; ela nunca é necessária para o trabalho. ' +
  'Para conferir uma aprovação, use `team status`; para pesquisar o código, use Grep ou Glob no projeto.';

// ---------- contexto de aplicação (ADR-005) ----------

function rootFor(input) {
  const toolInput = input?.tool_input || {};
  const cwd = input?.cwd || process.cwd();
  const filePath = toolInput.file_path || toolInput.notebook_path || toolInput.path || '';
  return findTeamRoot(cwd) || (filePath ? findTeamRoot(path.dirname(path.resolve(cwd, filePath))) : null);
}

/**
 * Há time ativo neste diretório e o guard está ligado? Calculado **antes** e
 * separadamente da avaliação, para que o hook saiba o que fazer se a avaliação
 * lançar (ADR-005). Nunca lança: na dúvida, `enforcing: false`.
 */
export function enforcementContext(input) {
  try {
    const root = rootFor(input);
    if (!root) return { root: null, enforcing: false };
    try {
      return { root, enforcing: loadConfig(root).enforce !== false };
    } catch {
      return { root, enforcing: true }; // config corrompida: o padrão é aplicar
    }
  } catch {
    return { root: null, enforcing: false };
  }
}

const deny = (reason) => ({ deny: true, reason });
const allow = { deny: false };

/**
 * Avalia uma chamada de ferramenta. `deps.getBranch` pode ser trocado nos testes
 * (aceita `BranchInfo`, string ou `null`); `deps.hasBaseCommit` também.
 * Retorna { deny: boolean, reason?: string }.
 */
export function evaluateToolCall(input, deps = {}) {
  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const filePath = toolInput.file_path || toolInput.notebook_path || toolInput.path || '';

  const root = rootFor(input);
  if (!root) return allow;

  let config;
  try {
    config = loadConfig(root);
  } catch {
    config = defaultConfig(); // config corrompida: aplica o padrão mais restritivo
  }
  if (config.enforce === false) return allow;

  if (FILE_TOOLS.has(toolName)) {
    const r = protectedFileReason(filePath, cwd);
    return r ? deny(r) : allow;
  }

  if (toolName === 'Read') {
    const key = keyFilePath();
    for (const target of searchTargets('Read', toolInput, cwd)) {
      if (isUnresolvedAlias(target)) return deny(UNRESOLVED_ALIAS_REASON);
      if (samePath(target, key) || isKeyAlias(target)) return deny(KEY_READ_REASON);
    }
    return allow;
  }

  if (SEARCH_TOOLS.has(toolName)) {
    for (const { target, fromRegex } of searchTargetEntries(toolName, toolInput, cwd)) {
      if (isUnresolvedAlias(target)) return deny(UNRESOLVED_ALIAS_REASON);
      if (reachesKey(target)) return deny(SEARCH_TARGET_REASON);
      if (!fromRegex && (isKeyAlias(target) || isRuntimeAlias(target))) return deny(SEARCH_TARGET_REASON);
    }
    return allow;
  }

  if (!SHELL_TOOLS.has(toolName)) return allow;
  const command = String(toolInput.command || '');
  if (!command.trim()) return allow;
  if (isStandaloneTeamCall(command)) return allow;

  const pathReason = shellPathReason(command);
  if (pathReason) return deny(pathReason);

  let state;
  try {
    state = loadState(root);
  } catch {
    state = { status: 'IDLE', work: null };
  }
  const track = state.work?.track || 'G';
  const mains = config.main_branches || ['main', 'master'];

  if (/\b(git|gh)\b/.test(command)) {
    const action = classifyGitCommand(command, mains);
    if (action) {
      const branch = normalizeBranchInfo((deps.getBranch || resolveBranch)(cwd));
      // Branch indeterminada: nada que altere histórico passa (CA-01.2, RNF-04).
      if (branch.kind === 'unknown') {
        // `unknownBranchMessage` já traz o próximo passo (pedir ao usuário para verificar).
        return deny(`${unknownBranchMessage(branch.detail)} O comando não foi executado.`);
      }
      // `no-repo` e `detached` não são a principal (CA-01.7, comportamento da v1.0).
      const onMain = action.targetsMain || (branch.kind === 'branch' && mains.includes(branch.name));
      if (onMain) {
        const g3ok = !gateEnabled(config, track, 'G3') || checkApproval(root, state, 'G3').valid;
        if (state.status !== 'MERGING' || !g3ok) {
          let reason =
            `${action.label} só é permitido no estado MERGING, depois do gate G3 aprovado pelo usuário ` +
            `(estado atual: ${state.status}${g3ok ? '' : ', G3 sem aprovação válida'}). ` +
            'Trabalhe na branch do work item e leve o resultado ao gate G3.';
          // Só agora vale pagar a sonda de commit base (ADR-001: preguiçosa).
          if (branch.kind === 'branch' && mains.includes(branch.name)
            && (deps.hasBaseCommit || hasBaseCommit)(cwd) === false) {
            reason += ` ${missingBaseCommitMessage(branch.name)}`;
          }
          return deny(reason);
        }
      }
    }
  }

  const deploy = detectDeploy(command, config.deploy || defaultConfig().deploy);
  if (deploy) {
    if (deploy.production) {
      const prodOk = checkApproval(root, state, 'PROD').valid;
      if (state.status !== 'DEPLOYING_PROD' || !prodOk) {
        return deny(
          `Comando de deploy em PRODUÇÃO detectado. Só é permitido em DEPLOYING_PROD com "APROVAR PROD" do usuário ` +
            `(estado atual: ${state.status}${prodOk ? '' : ', PROD sem aprovação válida'}). Esta regra não é configurável.`,
        );
      }
    } else {
      const g4ok = !gateEnabled(config, track, 'G4') || checkApproval(root, state, 'G4').valid;
      if (!['DEPLOYING', 'DEPLOYING_PROD'].includes(state.status) || !g4ok) {
        return deny(
          `Comando de deploy detectado. Só é permitido em DEPLOYING, depois do gate G4 aprovado pelo usuário ` +
            `(estado atual: ${state.status}${g4ok ? '' : ', G4 sem aprovação válida'}). ` +
            'Se não for um deploy, o usuário pode ajustar deploy.patterns em .team/config.json.',
        );
      }
    }
  }

  return allow;
}
