#!/usr/bin/env node
// CLI do time de agentes. Único caminho permitido para alterar .team/state.json.
// Aprovações NÃO passam por aqui: só o hook UserPromptSubmit as registra.

import { parseArgs } from 'node:util';
import path from 'node:path';
import {
  TeamError,
  GATES,
  findTeamRoot,
  initTeam,
  loadConfig,
  loadState,
  startWork,
  moveTo,
  cancelWork,
  addTask,
  setTask,
  readyTasks,
  availableTransitions,
  checkApproval,
  gateEnabled,
  appendLog,
} from '../lib/core.mjs';

const HELP = `team — estado e fluxo do time de agentes

Uso: node "$HOME/.claude/team/bin/team.mjs" <comando> [opções] [--root <dir>]

  init                                   cria .team/ no projeto (config padrão: todos os gates ligados)
  start <slug> --track P|M|G [--title T] inicia um work item (estado PLANNING)
  status [--json]                        estado, gates, transições possíveis e tarefas
  move <ESTADO> [--reason R]             muda de fase (valida transição e aprovações)
  cancel [--reason R]                    cancela o work item ativo
  task add <id> --agent A [--title T] [--deps T1,T2] [--files "src/api/**"]
  task set <id> <pending|in_progress|done|failed|blocked|rework> [--note N]
  task list [--json]                     todas as tarefas
  task ready [--json]                    tarefas prontas para rodar (podem ir em paralelo)
  log <evento> [--agent A] [--task T] [--msg M]

Aprovar/reprovar gates é exclusivo do usuário, digitando no chat:
  APROVAR G1 | APROVAR G2 | APROVAR G3 | APROVAR G4 | APROVAR PROD
  REPROVAR G2 <motivo>
`;

const { values: opt, positionals: pos } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    track: { type: 'string' },
    title: { type: 'string' },
    agent: { type: 'string' },
    deps: { type: 'string' },
    files: { type: 'string' },
    reason: { type: 'string' },
    note: { type: 'string' },
    msg: { type: 'string' },
    task: { type: 'string' },
    root: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

function out(obj) {
  process.stdout.write(typeof obj === 'string' ? obj + '\n' : JSON.stringify(obj, null, 2) + '\n');
}

function resolveRoot({ forInit = false } = {}) {
  const base = opt.root ? path.resolve(opt.root) : process.cwd();
  if (forInit) return base;
  const root = findTeamRoot(base);
  if (!root) throw new TeamError(`Nenhum .team/ encontrado a partir de ${base}. Rode \`team init\` na raiz do projeto.`);
  return root;
}

function gateLine(root, state, config) {
  if (!state.work) return '';
  return GATES.map((g) => {
    if (!gateEnabled(config, state.work.track, g)) return `${g} ⏭️ desligado`;
    const chk = checkApproval(root, state, g);
    if (chk.valid) return `${g} ✅`;
    return `${g} ⏳${g === 'PROD' ? ' (sempre)' : ''}`;
  }).join('  ');
}

function statusCmd() {
  const root = resolveRoot();
  const config = loadConfig(root);
  const state = loadState(root);
  const transitions = availableTransitions(root, state, config);
  const ready = readyTasks(state);

  if (opt.json) {
    out({
      root,
      project: state.project,
      status: state.status,
      work: state.work,
      gates: state.work
        ? Object.fromEntries(GATES.map((g) => [g, {
            enabled: gateEnabled(config, state.work.track, g),
            approved: checkApproval(root, state, g).valid,
          }]))
        : null,
      transitions: transitions.map(({ to, approval, rework, allowed, reason }) => ({ to, approval, rework, allowed, reason })),
      ready_tasks: ready.map((t) => t.id),
      last_work: state.last_work ? { id: state.last_work.id, status: state.status } : undefined,
    });
    return;
  }

  const lines = [`Projeto: ${state.project}   (${root})`, `Estado:  ${state.status}`];
  if (!state.work) {
    if (state.last_work) lines.push(`Último work item: ${state.last_work.id}`);
    lines.push('Nenhum work item ativo. Próximo passo: `team start <slug> --track P|M|G --title "..."`.');
    out(lines.join('\n'));
    return;
  }
  const w = state.work;
  lines.push(`Work:    ${w.id} — ${w.title}  (trilha ${w.track}, branch ${w.branch})`);
  lines.push(`Gates:   ${gateLine(root, state, config)}`);
  lines.push('Próximas transições:');
  for (const t of transitions) {
    const tag = t.approval ? (t.allowed ? `requer ${t.approval} — aprovado` : `requer ${t.approval} — BLOQUEADO`) : t.rework ? 'retrabalho' : 'livre';
    lines.push(`  → ${t.to}  [${tag}]`);
  }
  const tasks = Object.entries(w.tasks);
  if (tasks.length) {
    lines.push('Tarefas:');
    for (const [id, t] of tasks) {
      const deps = t.deps.length ? `  deps: ${t.deps.join(',')}` : '';
      const tries = t.attempts ? `  retrabalhos: ${t.attempts}/${config.max_rework_attempts}` : '';
      lines.push(`  ${id.padEnd(14)} ${t.status.padEnd(12)} ${t.agent.padEnd(14)} ${t.title}${deps}${tries}`);
    }
    lines.push(`Prontas para rodar: ${ready.map((t) => t.id).join(', ') || '(nenhuma)'}`);
  }
  const waiting = Object.entries({
    WAITING_G1_APPROVAL: 'G1', WAITING_G2_APPROVAL: 'G2', WAITING_G3_APPROVAL: 'G3',
    WAITING_G4_APPROVAL: 'G4', WAITING_PROD_APPROVAL: 'PROD',
  }).find(([s]) => s === state.status);
  if (waiting) lines.push(`⏸️  Aguardando o usuário digitar: APROVAR ${waiting[1]}  (ou REPROVAR ${waiting[1]} <motivo>)`);
  out(lines.join('\n'));
}

function taskCmd(sub, id, status) {
  const root = resolveRoot();
  switch (sub) {
    case 'add': {
      const deps = opt.deps ? String(opt.deps).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const t = addTask(root, { id, agent: opt.agent, title: opt.title, deps, files: opt.files || '' });
      out(`Tarefa ${id} criada (${t.agent})${deps.length ? `, depende de ${deps.join(', ')}` : ''}.`);
      break;
    }
    case 'set': {
      const t = setTask(root, id, status, { note: opt.note || '' });
      out(`Tarefa ${id} → ${t.status}${t.attempts ? ` (retrabalhos: ${t.attempts})` : ''}.`);
      break;
    }
    case 'list':
    case 'ready': {
      const state = loadState(root);
      const list = sub === 'ready'
        ? readyTasks(state)
        : Object.entries(state.work?.tasks || {}).map(([tid, t]) => ({ id: tid, ...t }));
      if (opt.json) return out(list);
      if (!list.length) return out(sub === 'ready' ? 'Nenhuma tarefa pronta.' : 'Nenhuma tarefa.');
      out(list.map((t) => `${t.id}\t${t.status}\t${t.agent}\t${t.title}${t.files ? `\tarquivos: ${t.files}` : ''}`).join('\n'));
      break;
    }
    default:
      throw new TeamError('Uso: team task add|set|list|ready ...');
  }
}

function main() {
  const [cmd, ...args] = pos;
  if (!cmd || opt.help || cmd === 'help') return out(HELP);
  switch (cmd) {
    case 'init': {
      const root = resolveRoot({ forInit: true });
      initTeam(root);
      out(`.team/ criado em ${root} (todos os gates ligados; .team/ adicionado ao .gitignore se houver git).`);
      break;
    }
    case 'start': {
      const root = resolveRoot();
      const w = startWork(root, { slug: args[0], title: opt.title, track: opt.track });
      out(`Work item ${w.id} iniciado (trilha ${w.track}). Estado: PLANNING. Branch sugerida: ${w.branch}`);
      break;
    }
    case 'status':
      statusCmd();
      break;
    case 'move': {
      if (!args[0]) throw new TeamError('Uso: team move <ESTADO> [--reason R]');
      const root = resolveRoot();
      const r = moveTo(root, args[0], { reason: opt.reason || '' });
      out(`${r.from} → ${r.to}${r.revoked?.length ? `  (aprovações revogadas: ${r.revoked.join(', ')})` : ''}`);
      break;
    }
    case 'cancel': {
      const root = resolveRoot();
      cancelWork(root, opt.reason || '');
      out('Work item cancelado.');
      break;
    }
    case 'task':
      taskCmd(args[0], args[1], args[2]);
      break;
    case 'log': {
      if (!args[0]) throw new TeamError('Uso: team log <evento> [--agent A] [--task T] [--msg M]');
      const root = resolveRoot();
      const state = loadState(root);
      appendLog(root, {
        actor: 'orchestrator',
        event: args[0],
        work: state.work?.id,
        agent: opt.agent,
        task: opt.task,
        msg: opt.msg,
      });
      out('ok');
      break;
    }
    default:
      throw new TeamError(`Comando desconhecido: ${cmd}\n\n${HELP}`);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof TeamError) {
    process.stderr.write(`✖ ${err.message}\n`);
    process.exit(err.exitCode);
  }
  process.stderr.write(`✖ Erro inesperado: ${err.stack || err}\n`);
  process.exit(1);
}
