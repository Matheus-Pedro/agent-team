#!/usr/bin/env node
// Remove o que o install.mjs instalou. Mantém team/approval.key (as aprovações já
// registradas nos projetos continuam verificáveis se você reinstalar).
// Uso: node scripts/uninstall.mjs [--claude-dir <dir>] [--dry-run]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO } from './build.mjs';
import { removeOurHooks } from './settings-hooks.mjs';

const { values } = parseArgs({
  options: { 'claude-dir': { type: 'string' }, 'dry-run': { type: 'boolean' } },
});
const CLAUDE = path.resolve(values['claude-dir'] || path.join(os.homedir(), '.claude'));
const DRY = Boolean(values['dry-run']);
const TEAM = path.join(CLAUDE, 'team');
const done = [];
const act = (desc, fn) => {
  done.push(desc);
  if (!DRY) fn();
};

const settingsFile = path.join(CLAUDE, 'settings.json');
if (fs.existsSync(settingsFile)) {
  const current = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const next = removeOurHooks(current);
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    act('remover hooks do settings.json (com backup)', () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(settingsFile, `${settingsFile}.bak-${stamp}`);
      fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2) + '\n');
    });
  }
}

const roles = fs.readdirSync(path.join(REPO, 'src', 'roles')).filter((f) => f.endsWith('.md'));
for (const f of roles) {
  const p = path.join(CLAUDE, 'agents', f);
  if (fs.existsSync(p)) act(`remover agents/${f}`, () => fs.rmSync(p));
}
for (const s of fs.readdirSync(path.join(REPO, 'src', 'skills'))) {
  const p = path.join(CLAUDE, 'skills', s);
  if (fs.existsSync(p)) act(`remover skills/${s}/`, () => fs.rmSync(p, { recursive: true, force: true }));
}
for (const d of ['bin', 'hooks', 'lib', 'VERSION']) {
  const p = path.join(TEAM, d);
  if (fs.existsSync(p)) act(`remover team/${d}`, () => fs.rmSync(p, { recursive: true, force: true }));
}

console.log(`${DRY ? '[dry-run] ' : ''}Desinstalação em ${CLAUDE}`);
for (const d of done) console.log(`  • ${d}`);
if (!done.length) console.log('  (nada instalado)');
