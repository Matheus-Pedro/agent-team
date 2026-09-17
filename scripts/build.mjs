#!/usr/bin/env node
// Gera dist/ a partir de src/:
//   dist/agents/<papel>.md = frontmatter + prompt do papel + contrato comum
//   dist/skills/**         = cópia das skills (orchestrator)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = path.join(REPO, 'dist');
const SRC = path.join(REPO, 'src');

export function parseFrontmatter(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: frontmatter ausente`);
  const fields = Object.fromEntries(
    m[1].split(/\r?\n/).filter((l) => /^\w[\w-]*:/.test(l)).map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  return { raw: m[1], fields, body: m[2].trim() };
}

export function build({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const common = fs.readFileSync(path.join(SRC, 'common', 'agent-contract.md'), 'utf8').trim();

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'agents'), { recursive: true });

  const roles = fs.readdirSync(path.join(SRC, 'roles')).filter((f) => f.endsWith('.md')).sort();
  const names = [];
  for (const file of roles) {
    const text = fs.readFileSync(path.join(SRC, 'roles', file), 'utf8');
    const fm = parseFrontmatter(text, file);
    const name = fm.fields.name;
    if (!name || `${name}.md` !== file) throw new Error(`${file}: "name" deve ser igual ao nome do arquivo`);
    if (!fm.fields.description) throw new Error(`${file}: "description" é obrigatório`);
    const out = [
      '---',
      fm.raw,
      '---',
      '',
      `<!-- GERADO por agent-team (scripts/build.mjs) a partir de src/roles/${file} + src/common/agent-contract.md. Edite no repositório, não aqui. -->`,
      '',
      fm.body,
      '',
      '---',
      '',
      common,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(DIST, 'agents', file), out);
    names.push(name);
  }
  log(`agents: ${names.join(', ')}`);

  fs.cpSync(path.join(SRC, 'skills'), path.join(DIST, 'skills'), { recursive: true });
  const skills = fs.readdirSync(path.join(DIST, 'skills'));
  for (const s of skills) {
    const text = fs.readFileSync(path.join(DIST, 'skills', s, 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(text, `skills/${s}/SKILL.md`);
    if (fm.fields.name !== s) throw new Error(`skills/${s}: "name" deve ser "${s}"`);
  }
  log(`skills: ${skills.join(', ')}`);
  return { agents: names, skills };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
  console.log(`build ok → ${DIST}`);
}
