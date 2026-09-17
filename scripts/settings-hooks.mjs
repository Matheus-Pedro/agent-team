// Mescla/remove os hooks do agent-team em settings.json sem mexer no resto.

import path from 'node:path';

export const PRE_TOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Read|Grep|Glob';

const HOOK_RE = /\/team\/hooks\/(guard|prompt-approval)\.mjs\b/;
const isOurs = (h) => typeof h?.command === 'string' && HOOK_RE.test(h.command.replace(/\\/g, '/'));

export function removeOurHooks(settings) {
  const s = structuredClone(settings);
  if (!s.hooks) return s;
  for (const event of Object.keys(s.hooks)) {
    s.hooks[event] = (s.hooks[event] || [])
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((group) => group.hooks.length > 0);
    if (!s.hooks[event].length) delete s.hooks[event];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

export function addOurHooks(settings, teamDir) {
  const s = removeOurHooks(settings);
  const cmd = (script) => `node "${path.join(teamDir, 'hooks', script).replace(/\\/g, '/')}"`;
  s.hooks ||= {};
  (s.hooks.UserPromptSubmit ||= []).push({
    hooks: [{ type: 'command', command: cmd('prompt-approval.mjs'), timeout: 10 }],
  });
  (s.hooks.PreToolUse ||= []).push({
    matcher: PRE_TOOL_MATCHER,
    hooks: [{ type: 'command', command: cmd('guard.mjs'), timeout: 10 }],
  });
  return s;
}
