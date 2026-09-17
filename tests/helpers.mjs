import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cada processo de teste usa um TEAM_HOME próprio (chave HMAC isolada).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-home-'));
process.env.AGENT_TEAM_HOME = home;

export const core = await import('../runtime/lib/core.mjs');
export const rules = await import('../runtime/lib/guard-rules.mjs');

export const TEAM_HOME = home;
export const REPO = path.resolve(import.meta.dirname, '..');

export function tmpProject({ git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-proj-'));
  if (git) fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

export function initProject(opts) {
  const root = tmpProject(opts);
  core.initTeam(root);
  return root;
}

export function editConfig(root, fn) {
  const file = path.join(root, '.team', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(cfg);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

const PATH_TO = {
  WAITING_G1_APPROVAL: ['WAITING_G1_APPROVAL'],
  ARCHITECTING: ['WAITING_G1_APPROVAL', 'G1', 'ARCHITECTING'],
  IMPLEMENTING: ['WAITING_G1_APPROVAL', 'G1', 'ARCHITECTING', 'WAITING_G2_APPROVAL', 'G2', 'IMPLEMENTING'],
};
PATH_TO.WAITING_G3_APPROVAL = [...PATH_TO.IMPLEMENTING, 'TESTING', 'REVIEWING', 'WAITING_G3_APPROVAL'];
PATH_TO.MERGING = [...PATH_TO.WAITING_G3_APPROVAL, 'G3', 'MERGING'];
PATH_TO.PREPARING_DEPLOY = [...PATH_TO.MERGING, 'MERGED', 'PREPARING_DEPLOY'];
PATH_TO.DEPLOYING = [...PATH_TO.PREPARING_DEPLOY, 'WAITING_G4_APPROVAL', 'G4', 'DEPLOYING'];
PATH_TO.WAITING_PROD_APPROVAL = [...PATH_TO.DEPLOYING, 'WAITING_PROD_APPROVAL'];
PATH_TO.DEPLOYING_PROD = [...PATH_TO.WAITING_PROD_APPROVAL, 'PROD', 'DEPLOYING_PROD'];

/** Leva um work item recém-iniciado até `target`, aprovando os gates como o usuário faria. */
export function driveTo(root, target) {
  for (const step of PATH_TO[target]) {
    if (/^(G[1-4]|PROD)$/.test(step)) core.recordDecision(root, { gate: step, decision: 'approved' });
    else core.moveTo(root, step);
  }
}

export function startedProject(opts = {}) {
  const root = initProject(opts);
  core.startWork(root, { slug: 'estoque', title: 'Controle de estoque', track: opts.track || 'G' });
  return root;
}
