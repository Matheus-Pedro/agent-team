// Regras do hook PreToolUse. Só valem dentro de projetos com .team/config.json.
// Objetivo: impedir que o modelo avance sem aprovação humana (merge, deploy,
// edição do estado/aprovações). É uma barreira contra erro e alucinação do
// modelo — não é um sandbox contra alguém tentando burlar deliberadamente.

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  findTeamRoot,
  loadConfig,
  loadState,
  defaultConfig,
  checkApproval,
  gateEnabled,
} from './core.mjs';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const slash = (s) => String(s || '').replace(/\\/g, '/');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TEAM_CLI_RE =
  /^\s*node(?:\.exe)?\s+(?:"[^"]*\.claude\/team\/bin\/team\.mjs"|'[^']*\.claude\/team\/bin\/team\.mjs'|[^\s"']*\.claude\/team\/bin\/team\.mjs)(?:\s|$)/i;
const SHELL_META_RE = /[;&|<>`\r\n]|\$\(/;

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

export function shellPathReason(command) {
  const n = slash(command).toLowerCase();
  if (n.includes('approval.key')) return 'a chave de assinatura das aprovações não pode ser acessada';
  if (/\.claude\/team(\/|\b)/.test(n)) {
    return 'o runtime do time só pode ser usado como comando isolado: node "$HOME/.claude/team/bin/team.mjs" <args> (sem ;, &&, |, >, $( ))';
  }
  if (/\.team\/(approvals|logs)\b/.test(n)) return 'aprovações e logs não podem ser manipulados via shell';
  if (/\.team\/(state|config)\.json/.test(n)) return 'estado/config do time não podem ser manipulados via shell — use o CLI `team` (leitura: ferramenta Read)';
  if (/(^|[\s"'=/])\.team(\/|[\s"']|$)/.test(n) && DELETE_VERBS_RE.test(n)) return 'o diretório .team não pode ser removido ou movido pelo agente';
  if (/\bgit\s+clean\b[^;&|]*\s-[a-z]*x/i.test(command)) return '`git clean -x/-X` apagaria o .team/ (ignorado pelo git)';
  if (/\.claude\/settings(\.local)?\.json/.test(n) && WRITE_VERBS_RE.test(n)) return 'hooks e permissões só podem ser alterados pelo usuário';
  return null;
}

export function detectMerge(command, branch, mainBranches) {
  const n = slash(command);
  const alt = mainBranches.map(escapeRe).join('|');
  const end = String.raw`(?=$|[\s;&|)"'])`;
  const switchesToMain = new RegExp(String.raw`\bgit\s+(checkout|switch)\s+(${alt})${end}`).test(n);
  const onMain = (branch && mainBranches.includes(branch)) || switchesToMain;

  if (/\bgh\s+pr\s+merge\b/.test(n)) return 'gh pr merge';
  if (/\bgit\s+merge\b/.test(n) && onMain) return 'merge na branch principal';
  if (/\bgit\s+(commit|cherry-pick|revert|am|rebase)\b/.test(n) && onMain) return 'alteração de histórico na branch principal';
  if (/\bgit\s+push\b/.test(n)) {
    if (onMain) return 'push a partir da branch principal';
    if (new RegExp(String.raw`\bgit\s+push\b[^;&|]*[\s:+](${alt})${end}`).test(n)) return 'push para a branch principal';
  }
  if (new RegExp(String.raw`\bgit\s+(update-ref\s+refs/heads/|branch\s+(-f|--force|-M|-D)\s+)(${alt})${end}`).test(n)) {
    return 'alteração direta da branch principal';
  }
  return null;
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

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const deny = (reason) => ({ deny: true, reason });
const allow = { deny: false };

/**
 * Avalia uma chamada de ferramenta. `deps.getBranch` pode ser trocado nos testes.
 * Retorna { deny: boolean, reason?: string }.
 */
export function evaluateToolCall(input, deps = {}) {
  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const filePath = toolInput.file_path || toolInput.notebook_path || toolInput.path || '';

  const root = findTeamRoot(cwd) || (filePath ? findTeamRoot(path.dirname(path.resolve(cwd, filePath))) : null);
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

  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    const n = slash(`${filePath} ${toolInput.pattern || ''} ${toolInput.glob || ''}`).toLowerCase();
    if (n.includes('approval.key')) return deny('a chave de assinatura das aprovações não pode ser lida');
    if (toolName !== 'Read' && /\.claude\/team(\/|\s|$)/.test(n)) return deny('busca no runtime do time não é permitida');
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

  const mentionsGit = /\b(git|gh)\b/.test(command);
  if (mentionsGit) {
    const branch = mentionsGit ? (deps.getBranch || currentBranch)(cwd) : null;
    const merge = detectMerge(command, branch, config.main_branches || ['main', 'master']);
    if (merge) {
      const g3ok = !gateEnabled(config, track, 'G3') || checkApproval(root, state, 'G3').valid;
      if (state.status !== 'MERGING' || !g3ok) {
        return deny(
          `${merge} só é permitido no estado MERGING, depois do gate G3 aprovado pelo usuário ` +
            `(estado atual: ${state.status}${g3ok ? '' : ', G3 sem aprovação válida'}). ` +
            'Trabalhe na branch do work item e leve o resultado ao gate G3.',
        );
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
