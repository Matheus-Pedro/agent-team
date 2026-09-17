// Núcleo do runtime do time de agentes: config, estado, máquina de estados,
// aprovações assinadas (HMAC), DAG de tarefas e log de auditoria.
// Usado pelo CLI (bin/team.mjs) e pelos hooks (hooks/*.mjs).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const TEAM_HOME = process.env.AGENT_TEAM_HOME || path.join(os.homedir(), '.claude', 'team');
export const KEY_FILE = path.join(TEAM_HOME, 'approval.key');

export const TRACKS = ['P', 'M', 'G'];
export const CONFIGURABLE_GATES = ['G1', 'G2', 'G3', 'G4'];
export const GATES = [...CONFIGURABLE_GATES, 'PROD']; // PROD nunca é configurável

// Ordem linear das fases. A posição é usada para revogar aprovações em retrabalho.
export const STATE_ORDER = [
  'PLANNING',
  'WAITING_G1_APPROVAL',
  'ARCHITECTING',
  'WAITING_G2_APPROVAL',
  'IMPLEMENTING',
  'TESTING',
  'REVIEWING',
  'WAITING_G3_APPROVAL',
  'MERGING',
  'MERGED',
  'PREPARING_DEPLOY',
  'WAITING_G4_APPROVAL',
  'DEPLOYING',
  'WAITING_PROD_APPROVAL',
  'DEPLOYING_PROD',
  'DEPLOYED',
  'DONE',
];
export const TERMINAL_STATES = ['IDLE', 'DONE', 'CANCELLED'];

export const GATE_STATE = {
  G1: 'WAITING_G1_APPROVAL',
  G2: 'WAITING_G2_APPROVAL',
  G3: 'WAITING_G3_APPROVAL',
  G4: 'WAITING_G4_APPROVAL',
  PROD: 'WAITING_PROD_APPROVAL',
};

const on = (gate) => ({ ifGate: gate, enabled: true });
const off = (gate) => ({ ifGate: gate, enabled: false });

// Transições permitidas. `approval` = exige aprovação válida daquele gate.
// `cond` = transição só existe se o gate estiver habilitado/desabilitado na config.
export const TRANSITIONS = {
  PLANNING: [
    { to: 'WAITING_G1_APPROVAL', cond: on('G1') },
    { to: 'ARCHITECTING', cond: off('G1') },
  ],
  WAITING_G1_APPROVAL: [
    { to: 'ARCHITECTING', approval: 'G1' },
    { to: 'PLANNING', rework: true },
  ],
  ARCHITECTING: [
    { to: 'WAITING_G2_APPROVAL', cond: on('G2') },
    { to: 'IMPLEMENTING', cond: off('G2') },
    { to: 'PLANNING', rework: true },
  ],
  WAITING_G2_APPROVAL: [
    { to: 'IMPLEMENTING', approval: 'G2' },
    { to: 'ARCHITECTING', rework: true },
  ],
  IMPLEMENTING: [
    { to: 'TESTING' },
    { to: 'ARCHITECTING', rework: true },
    { to: 'PLANNING', rework: true },
  ],
  TESTING: [
    { to: 'REVIEWING' },
    { to: 'IMPLEMENTING', rework: true },
  ],
  REVIEWING: [
    { to: 'WAITING_G3_APPROVAL', cond: on('G3') },
    { to: 'MERGING', cond: off('G3') },
    { to: 'IMPLEMENTING', rework: true },
  ],
  WAITING_G3_APPROVAL: [
    { to: 'MERGING', approval: 'G3' },
    { to: 'IMPLEMENTING', rework: true },
  ],
  MERGING: [{ to: 'MERGED' }],
  MERGED: [{ to: 'PREPARING_DEPLOY' }, { to: 'DONE' }],
  PREPARING_DEPLOY: [
    { to: 'WAITING_G4_APPROVAL', cond: on('G4') },
    { to: 'DEPLOYING', cond: off('G4') },
  ],
  WAITING_G4_APPROVAL: [
    { to: 'DEPLOYING', approval: 'G4' },
    { to: 'PREPARING_DEPLOY', rework: true },
  ],
  DEPLOYING: [
    { to: 'DEPLOYED' },
    { to: 'WAITING_PROD_APPROVAL' },
    { to: 'PREPARING_DEPLOY', rework: true },
  ],
  WAITING_PROD_APPROVAL: [
    { to: 'DEPLOYING_PROD', approval: 'PROD' },
    { to: 'PREPARING_DEPLOY', rework: true },
  ],
  DEPLOYING_PROD: [{ to: 'DEPLOYED' }, { to: 'PREPARING_DEPLOY', rework: true }],
  DEPLOYED: [{ to: 'DONE' }],
};

export const TASK_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'blocked', 'rework'];

export const DEFAULT_DEPLOY_PATTERNS = [
  String.raw`\bdocker\s+push\b`,
  String.raw`\bkubectl\s+(apply|create|replace|rollout|set|delete|scale)\b`,
  String.raw`\bhelm\s+(install|upgrade|uninstall|rollback)\b`,
  String.raw`\bterraform\s+(apply|destroy|import)\b`,
  String.raw`\bpulumi\s+(up|destroy)\b`,
  String.raw`\baz\s+(webapp|functionapp|containerapp|staticwebapp|aks|acr)\b.*\b(deploy|up|create|update|push)\b`,
  String.raw`\baws\s+(ecs|lambda|s3|cloudformation|elasticbeanstalk)\b.*\b(deploy|update|sync|put|create)\b`,
  String.raw`\bgcloud\s+.*\bdeploy\b`,
  String.raw`\bvercel(\s+(deploy|promote|alias|--prod)\b|\s*$)`,
  String.raw`\bnetlify\s+deploy\b`,
  String.raw`\bfly(ctl)?\s+deploy\b`,
  String.raw`\brailway\s+up\b`,
  String.raw`\bfirebase\s+deploy\b`,
  String.raw`\bheroku\b.*\b(deploy|releases|container:release)\b`,
  String.raw`\bgit\s+push\s+heroku\b`,
  String.raw`\bgh\s+workflow\s+run\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?deploy\b`,
  String.raw`\bdotnet\s+publish\b.*PublishProfile`,
];

export const DEFAULT_PRODUCTION_PATTERNS = [
  String.raw`--prod\b`,
  String.raw`\bprod(uction)?\b`,
  String.raw`\bprd\b`,
];

export function defaultConfig() {
  const allOn = () => Object.fromEntries(CONFIGURABLE_GATES.map((g) => [g, true]));
  return {
    version: 1,
    enforce: true,
    main_branches: ['main', 'master'],
    max_rework_attempts: 2,
    gates: { P: allOn(), M: allOn(), G: allOn() },
    deploy: {
      patterns: DEFAULT_DEPLOY_PATTERNS,
      production_patterns: DEFAULT_PRODUCTION_PATTERNS,
    },
  };
}

export function emptyState(project) {
  return { version: 1, project, status: 'IDLE', work: null, history: [] };
}

// ---------- caminhos ----------

export function teamPaths(root) {
  const dir = path.join(root, '.team');
  return {
    root,
    dir,
    config: path.join(dir, 'config.json'),
    state: path.join(dir, 'state.json'),
    approvals: path.join(dir, 'approvals'),
    logs: path.join(dir, 'logs'),
    log: path.join(dir, 'logs', 'orchestration.jsonl'),
    work: path.join(dir, 'work'),
  };
}

/** Sobe a partir de `start` procurando um diretório com `.team/config.json`. */
export function findTeamRoot(start) {
  if (!start) return null;
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    try {
      if (fs.statSync(path.join(dir, '.team', 'config.json')).isFile()) return dir;
    } catch {
      /* continua subindo */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ---------- IO ----------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function loadConfig(root) {
  const cfg = readJson(teamPaths(root).config);
  const def = defaultConfig();
  return {
    ...def,
    ...cfg,
    gates: { ...def.gates, ...(cfg.gates || {}) },
    deploy: { ...def.deploy, ...(cfg.deploy || {}) },
  };
}

export function loadState(root) {
  return readJson(teamPaths(root).state);
}

export function saveState(root, state) {
  writeJsonAtomic(teamPaths(root).state, state);
}

export function appendLog(root, entry) {
  const p = teamPaths(root);
  fs.mkdirSync(p.logs, { recursive: true });
  fs.appendFileSync(p.log, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

export function initTeam(root) {
  const p = teamPaths(root);
  if (fs.existsSync(p.config)) {
    throw new TeamError(`.team já inicializado em ${root}. A config só pode ser alterada pelo usuário, manualmente.`);
  }
  fs.mkdirSync(p.approvals, { recursive: true });
  fs.mkdirSync(p.logs, { recursive: true });
  fs.mkdirSync(p.work, { recursive: true });
  writeJsonAtomic(p.config, defaultConfig());
  if (!fs.existsSync(p.state)) writeJsonAtomic(p.state, emptyState(path.basename(root)));
  ensureGitignore(root);
  appendLog(root, { actor: 'orchestrator', event: 'team_initialized' });
}

function ensureGitignore(root) {
  if (!fs.existsSync(path.join(root, '.git'))) return;
  const gi = path.join(root, '.gitignore');
  const current = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (/^\/?\.team\/?\s*$/m.test(current)) return;
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gi, `${current}${sep}\n# estado operacional do time de agentes\n.team/\n`);
}

// ---------- erros ----------

export class TeamError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

// ---------- aprovações ----------

export function loadOrCreateKey() {
  try {
    return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  } catch {
    fs.mkdirSync(TEAM_HOME, { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

function signable(rec) {
  return JSON.stringify([rec.work_id, rec.gate, rec.decision, rec.decided_at, rec.state_at_decision, rec.actor]);
}

function sign(rec, key) {
  return crypto.createHmac('sha256', key).update(signable(rec)).digest('hex');
}

export function approvalFile(root, workId, gate) {
  return path.join(teamPaths(root).approvals, workId, `${gate}.json`);
}

/**
 * Registra a decisão do usuário sobre um gate. Só deve ser chamado pelo hook
 * UserPromptSubmit (mensagem digitada pelo usuário) — nunca pelo CLI.
 */
export function recordDecision(root, { gate, decision, note = '' }) {
  gate = gate.toUpperCase();
  if (!GATES.includes(gate)) throw new TeamError(`Gate desconhecido: ${gate}`);
  const state = loadState(root);
  const expected = GATE_STATE[gate];
  if (!state.work || state.status !== expected) {
    throw new TeamError(
      `Nenhuma decisão registrada: o estado atual é ${state.status}, e ${gate} só pode ser decidido em ${expected}.`,
    );
  }
  const rec = {
    work_id: state.work.id,
    gate,
    decision, // 'approved' | 'rejected'
    decided_at: new Date().toISOString(),
    state_at_decision: state.status,
    actor: 'user',
    note: note.slice(0, 2000),
  };
  rec.signature = sign(rec, loadOrCreateKey());
  const file = decision === 'approved'
    ? approvalFile(root, state.work.id, gate)
    : path.join(teamPaths(root).approvals, state.work.id, `${gate}.rejected.json`);
  writeJsonAtomic(file, rec);
  appendLog(root, { actor: 'user', event: decision, gate, work: state.work.id, note: rec.note || undefined });
  return rec;
}

/** Retorna { valid, reason, record } para a aprovação do gate no work item atual. */
export function checkApproval(root, state, gate) {
  if (!state.work) return { valid: false, reason: 'sem work item ativo' };
  const file = approvalFile(root, state.work.id, gate);
  let rec;
  try {
    rec = readJson(file);
  } catch {
    return { valid: false, reason: `${gate} não aprovado` };
  }
  let key;
  try {
    key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  } catch {
    return { valid: false, reason: 'chave de aprovação ausente — reinstale o runtime' };
  }
  const expected = sign(rec, key);
  const given = String(rec.signature || '');
  const sigOk = given.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!sigOk) return { valid: false, reason: `assinatura inválida em ${gate}` };
  if (rec.decision !== 'approved' || rec.actor !== 'user') return { valid: false, reason: `${gate} não aprovado` };
  if (rec.work_id !== state.work.id || rec.gate !== gate || rec.state_at_decision !== GATE_STATE[gate]) {
    return { valid: false, reason: `registro de ${gate} não corresponde ao work item atual` };
  }
  const revokedAt = state.work.revocations?.[gate];
  if (revokedAt && new Date(rec.decided_at) <= new Date(revokedAt)) {
    return { valid: false, reason: `${gate} foi revogado por retrabalho em ${revokedAt}` };
  }
  return { valid: true, record: rec };
}

export function gateEnabled(config, track, gate) {
  if (gate === 'PROD') return true;
  const g = config.gates?.[track]?.[gate];
  return g !== false; // na dúvida, o gate vale
}

// ---------- máquina de estados ----------

function transitionAvailable(t, config, track) {
  if (!t.cond) return true;
  return gateEnabled(config, track, t.cond.ifGate) === t.cond.enabled;
}

export function availableTransitions(root, state, config) {
  if (!state.work || TERMINAL_STATES.includes(state.status)) return [];
  return (TRANSITIONS[state.status] || [])
    .filter((t) => transitionAvailable(t, config, state.work.track))
    .map((t) => {
      if (!t.approval) return { ...t, allowed: true };
      const chk = checkApproval(root, state, t.approval);
      return { ...t, allowed: chk.valid, reason: chk.reason };
    });
}

function gatePosition(gate) {
  return STATE_ORDER.indexOf(GATE_STATE[gate]);
}

export function moveTo(root, target, { reason = '' } = {}) {
  target = target.toUpperCase();
  const config = loadConfig(root);
  const state = loadState(root);
  if (!state.work) throw new TeamError('Nenhum work item ativo. Use `team start`.');
  if (target === 'CANCELLED') return cancelWork(root, reason);

  const options = availableTransitions(root, state, config);
  const t = options.find((o) => o.to === target);
  if (!t) {
    const list = options.map((o) => o.to).join(', ') || '(nenhuma)';
    throw new TeamError(`Transição inválida: ${state.status} → ${target}. Permitidas: ${list}.`);
  }
  if (!t.allowed) {
    throw new TeamError(
      `Bloqueado: ${state.status} → ${target} exige aprovação humana de ${t.approval} (${t.reason}). ` +
        `Apresente o pacote de aprovação e aguarde o usuário digitar "APROVAR ${t.approval}".`,
      3,
    );
  }

  const now = new Date().toISOString();
  const from = state.status;
  // Retrabalho: toda aprovação de gate posterior ao destino deixa de valer.
  const revoked = [];
  if (t.rework) {
    const targetPos = STATE_ORDER.indexOf(target);
    state.work.revocations ||= {};
    for (const g of GATES) {
      if (gatePosition(g) > targetPos && checkApproval(root, state, g).valid) revoked.push(g);
      if (gatePosition(g) > targetPos) state.work.revocations[g] = now;
    }
  }
  state.status = target;
  state.work.status_history.push({ from, to: target, at: now, reason: reason || undefined });
  if (target === 'DONE') finishWork(state, now);
  saveState(root, state);
  appendLog(root, {
    actor: 'orchestrator',
    event: 'transition',
    work: state.work?.id ?? state.history.at(-1)?.id,
    from,
    to: target,
    reason: reason || undefined,
    revoked: revoked.length ? revoked : undefined,
  });
  return { from, to: target, revoked };
}

function finishWork(state, now) {
  state.history.push({
    id: state.work.id,
    title: state.work.title,
    track: state.work.track,
    final_status: state.status,
    started_at: state.work.started_at,
    finished_at: now,
  });
  state.last_work = state.work;
  state.work = null;
}

export function cancelWork(root, reason) {
  const state = loadState(root);
  if (!state.work) throw new TeamError('Nenhum work item ativo.');
  const from = state.status;
  const now = new Date().toISOString();
  state.status = 'CANCELLED';
  state.work.status_history.push({ from, to: 'CANCELLED', at: now, reason: reason || undefined });
  const id = state.work.id;
  finishWork(state, now);
  saveState(root, state);
  appendLog(root, { actor: 'orchestrator', event: 'cancelled', work: id, from, reason: reason || undefined });
  return { from, to: 'CANCELLED' };
}

export function startWork(root, { slug, title, track }) {
  track = String(track || '').toUpperCase();
  if (!TRACKS.includes(track)) throw new TeamError(`Trilha inválida: "${track}". Use P, M ou G.`);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug || '')) {
    throw new TeamError('Slug inválido: use letras minúsculas, números e hífen (ex.: controle-estoque).');
  }
  const state = loadState(root);
  if (state.work) {
    throw new TeamError(`Já existe um work item ativo: ${state.work.id} (${state.status}). Conclua ou cancele antes.`);
  }
  const seq = String(state.history.length + 1).padStart(3, '0');
  const id = `W-${seq}-${slug}`;
  const now = new Date().toISOString();
  state.status = 'PLANNING';
  state.work = {
    id,
    slug,
    title: title || slug,
    track,
    branch: `team/${id.toLowerCase()}`,
    started_at: now,
    status_history: [{ from: 'IDLE', to: 'PLANNING', at: now }],
    revocations: {},
    tasks: {},
  };
  delete state.last_work;
  saveState(root, state);
  fs.mkdirSync(path.join(teamPaths(root).work, id, 'briefs'), { recursive: true });
  fs.mkdirSync(path.join(teamPaths(root).work, id, 'results'), { recursive: true });
  appendLog(root, { actor: 'orchestrator', event: 'work_started', work: id, track, title: state.work.title });
  return state.work;
}

// ---------- DAG de tarefas ----------

function requireWork(state) {
  if (!state.work) throw new TeamError('Nenhum work item ativo. Use `team start`.');
  return state.work;
}

export function addTask(root, { id, agent, title, deps = [], files = '' }) {
  if (!/^[A-Za-z][\w-]{0,30}$/.test(id || '')) throw new TeamError('Id de tarefa inválido (ex.: T1, T3-backend).');
  if (!agent) throw new TeamError('Informe --agent.');
  const state = loadState(root);
  const work = requireWork(state);
  if (work.tasks[id]) throw new TeamError(`Tarefa ${id} já existe.`);
  for (const d of deps) {
    if (!work.tasks[d]) throw new TeamError(`Dependência inexistente: ${d}. Cadastre-a antes.`);
  }
  work.tasks[id] = { agent, title: title || id, deps, files, status: 'pending', attempts: 0 };
  saveState(root, state);
  appendLog(root, { actor: 'orchestrator', event: 'task_added', work: work.id, task: id, agent, deps });
  return work.tasks[id];
}

export function setTask(root, id, status, { note = '' } = {}) {
  if (!TASK_STATUSES.includes(status)) {
    throw new TeamError(`Status inválido: ${status}. Use: ${TASK_STATUSES.join(', ')}.`);
  }
  const config = loadConfig(root);
  const state = loadState(root);
  const work = requireWork(state);
  const task = work.tasks[id];
  if (!task) throw new TeamError(`Tarefa inexistente: ${id}.`);

  if (status === 'in_progress') {
    const pending = task.deps.filter((d) => work.tasks[d]?.status !== 'done');
    if (pending.length) throw new TeamError(`${id} depende de tarefas não concluídas: ${pending.join(', ')}.`);
  }
  if (status === 'rework') {
    if (task.attempts >= config.max_rework_attempts) {
      appendLog(root, { actor: 'orchestrator', event: 'rework_limit', work: work.id, task: id });
      throw new TeamError(
        `Limite de retrabalho atingido para ${id} (${task.attempts}/${config.max_rework_attempts}). ` +
          'Pare e escale ao usuário: problema, tentativas, causa provável e o que falta para continuar.',
        4,
      );
    }
    task.attempts += 1;
  }
  task.status = status;
  if (note) task.note = note.slice(0, 500);
  saveState(root, state);
  appendLog(root, {
    actor: 'orchestrator',
    event: 'task_status',
    work: work.id,
    task: id,
    agent: task.agent,
    status,
    attempts: task.attempts,
    note: note || undefined,
  });
  return task;
}

export function readyTasks(state) {
  if (!state.work) return [];
  const tasks = state.work.tasks;
  return Object.entries(tasks)
    .filter(([, t]) => ['pending', 'rework'].includes(t.status))
    .filter(([, t]) => t.deps.every((d) => tasks[d]?.status === 'done'))
    .map(([id, t]) => ({ id, ...t }));
}
