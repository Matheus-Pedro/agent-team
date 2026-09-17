#!/usr/bin/env node
// Instala o time de agentes em ~/.claude (ou --claude-dir):
//   agents/<papel>.md, skills/orquestrar/, team/{bin,hooks,lib}, chave de aprovação
//   e os hooks em settings.json (com backup).
// Uso: node scripts/install.mjs [--claude-dir <dir>] [--dry-run]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { build, DIST, REPO } from './build.mjs';
import { addOurHooks } from './settings-hooks.mjs';

const { values } = parseArgs({
  options: { 'claude-dir': { type: 'string' }, 'dry-run': { type: 'boolean' } },
});
const CLAUDE = path.resolve(values['claude-dir'] || path.join(os.homedir(), '.claude'));
const DRY = Boolean(values['dry-run']);
const TEAM = path.join(CLAUDE, 'team');

const actions = [];
const act = (desc, fn) => {
  actions.push(desc);
  if (!DRY) fn();
};

const { agents, skills } = build({ quiet: true });

// 1. agentes
fs.mkdirSync(path.join(CLAUDE, 'agents'), { recursive: true });
for (const name of agents) {
  const dest = path.join(CLAUDE, 'agents', `${name}.md`);
  const verb = fs.existsSync(dest) ? 'atualizar' : 'criar';
  act(`${verb} agents/${name}.md`, () => fs.copyFileSync(path.join(DIST, 'agents', `${name}.md`), dest));
}

// 2. skills
for (const s of skills) {
  const dest = path.join(CLAUDE, 'skills', s);
  act(`instalar skills/${s}/`, () => {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(DIST, 'skills', s), dest, { recursive: true });
  });
}

// 3. runtime (preserva approval.key)
act('instalar team/{bin,hooks,lib}', () => {
  for (const dir of ['bin', 'hooks', 'lib']) {
    fs.rmSync(path.join(TEAM, dir), { recursive: true, force: true });
    fs.cpSync(path.join(REPO, 'runtime', dir), path.join(TEAM, dir), { recursive: true });
  }
  let commit = 'desconhecido';
  try {
    commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* repo sem commits */ }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(TEAM, 'VERSION'), `${pkg.version} (${commit}) ${new Date().toISOString()}\nfonte: ${REPO}\n`);
});

const keyFile = path.join(TEAM, 'approval.key');
if (!fs.existsSync(keyFile)) {
  act('gerar team/approval.key', () => {
    fs.mkdirSync(TEAM, { recursive: true });
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  });
}

// 4. hooks em settings.json
const settingsFile = path.join(CLAUDE, 'settings.json');
const current = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
const next = addOurHooks(current, TEAM);
if (JSON.stringify(current) !== JSON.stringify(next)) {
  act('registrar hooks (UserPromptSubmit + PreToolUse) em settings.json', () => {
    if (fs.existsSync(settingsFile)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(settingsFile, `${settingsFile}.bak-${stamp}`);
    }
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2) + '\n');
  });
} else {
  actions.push('hooks já registrados em settings.json (sem mudanças)');
}

console.log(`${DRY ? '[dry-run] ' : ''}Instalação em ${CLAUDE}`);
for (const a of actions) console.log(`  • ${a}`);
if (!DRY) {
  console.log('\nPronto. Abra uma nova sessão no projeto e digite /orquestrar.');
  console.log('Para remover: node scripts/uninstall.mjs');
}
