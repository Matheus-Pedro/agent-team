#!/usr/bin/env node
// Mede o tempo de execução do hook PreToolUse (`runtime/hooks/guard.mjs`) em
// cenários distintos e imprime p50, p95 e máximo de cada um (RNF-03).
//
// Uso: node tests/perf-guard.mjs [--runs 50] [--warmup 5] [--json] [--no-gate]
//
// É um executável separado, fora do `npm test`: cada amostra é um processo Node
// novo, então a medição completa leva dezenas de segundos.
//
// Regras desta medição (dogfooding — ver docs/requirements/W-001-evolucao-v1-1.md):
//   - o hook é SEMPRE spawnado com `AGENT_TEAM_HOME` em diretório temporário;
//   - os projetos medidos são temporários, criados e removidos pelo script;
//   - nada é medido, lido ou escrito no `.team/` real deste repositório;
//   - nenhuma chave de assinatura é criada ou lida (nenhum cenário chega a ela).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const HOOK = path.join(REPO, 'runtime', 'hooks', 'guard.mjs');

// ---------- argumentos ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const num = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v) || v < 1) throw new Error(`Valor inválido para ${name}: ${argv[i + 1]}`);
  return Math.floor(v);
};

const RUNS = num('--runs', 50);
const WARMUP = num('--warmup', 5);
const JSON_ONLY = flag('--json');
const GATE = !flag('--no-gate');
const RNF03_P95_MS = 500;

// ---------- ambiente isolado ----------

// Precisa vir antes do import do core: TEAM_HOME é resolvido no carregamento.
const TEAM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-guard-home-'));
process.env.AGENT_TEAM_HOME = TEAM_HOME;
const { defaultConfig, emptyState } = await import('../runtime/lib/core.mjs');

const tmpDirs = [TEAM_HOME];
const mkTmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

/** Projeto temporário com git (commit base + branch de work item) e `.team/` ativo. */
function makeTeamProject() {
  const dir = mkTmp('perf-guard-proj-');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git('config', 'user.email', 'perf@example.invalid');
  git('config', 'user.name', 'perf-guard');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.mjs'), 'export const ok = true;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# projeto temporário de medição\n');
  git('add', '.');
  git('commit', '-m', 'commit base');
  git('checkout', '-b', 'team/w-001-perf');

  // `.team/` escrito direto em disco: não usamos o CLI nem `recordDecision`,
  // para não criar nem tocar a chave de assinatura.
  const team = path.join(dir, '.team');
  for (const sub of ['approvals', 'logs', 'work']) fs.mkdirSync(path.join(team, sub), { recursive: true });
  fs.writeFileSync(path.join(team, 'config.json'), JSON.stringify(defaultConfig(), null, 2) + '\n');
  const now = new Date().toISOString();
  const state = {
    ...emptyState(path.basename(dir)),
    status: 'IMPLEMENTING',
    work: {
      id: 'W-001-perf',
      slug: 'perf',
      title: 'Medicao de desempenho do guard',
      track: 'G',
      branch: 'team/w-001-perf',
      started_at: now,
      status_history: [{ from: 'IDLE', to: 'IMPLEMENTING', at: now }],
      revocations: {},
      tasks: {},
    },
  };
  fs.writeFileSync(path.join(team, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  return dir;
}

/** Diretório temporário sem `.team/` em nenhum ancestral. */
function makePlainDir() {
  const dir = mkTmp('perf-guard-plain-');
  fs.writeFileSync(path.join(dir, 'README.md'), '# diretório sem time\n');
  return dir;
}

// ---------- execução do hook ----------

function runHook(payload) {
  const t0 = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd: payload.cwd,
    encoding: 'utf8',
    env: { ...process.env, AGENT_TEAM_HOME: TEAM_HOME },
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.error) throw res.error;
  return { ms, status: res.status, stderr: res.stderr || '' };
}

const preToolUse = (cwd, tool_name, tool_input) => ({
  hook_event_name: 'PreToolUse',
  session_id: 'perf-guard',
  cwd,
  tool_name,
  tool_input,
});

// ---------- estatísticas ----------

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const rank = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return {
    n: s.length,
    min: s[0],
    p50: rank(0.5),
    p95: rank(0.95),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

const ms = (v) => `${v.toFixed(1)} ms`;

// ---------- cenários ----------

const project = makeTeamProject();
const plain = makePlainDir();

const scenarios = [
  {
    id: 'fora-de-projeto',
    label: 'Fora de projeto com time (Read)',
    expect: 0,
    payload: preToolUse(plain, 'Read', { file_path: path.join(plain, 'README.md') }),
    note: 'caminho mais curto: findTeamRoot devolve null e o guard libera',
  },
  {
    id: 'read-comum',
    label: 'Projeto com time · Read de arquivo comum',
    expect: 0,
    payload: preToolUse(project, 'Read', { file_path: path.join(project, 'src', 'app.mjs') }),
    note: 'lê .team/config.json; não executa git nem lê o estado',
  },
  {
    id: 'git',
    label: 'Projeto com time · comando git (git commit)',
    expect: 0,
    payload: preToolUse(project, 'Bash', { command: 'git commit -m "wip"' }),
    note: 'executa `git symbolic-ref` (1 spawn) para descobrir a branch e lê o estado',
  },
  {
    id: 'deploy-bloqueado',
    label: 'Projeto com time · deploy bloqueado (npm deploy)',
    expect: 2,
    payload: preToolUse(project, 'Bash', { command: 'npm run deploy' }),
    note: 'lê o estado e confere a aprovação do G4; bloqueia com exit 2',
  },
];

// ---------- sanidade (fora da medição) ----------

/* Sem estas duas checagens, um cenário poderia estar medindo o caminho errado
   (por exemplo, o guard liberando tudo porque não achou o projeto). */
const sanity = [];
const protectedWrite = (cwd) =>
  preToolUse(cwd, 'Write', { file_path: path.join(cwd, '.team', 'state.json'), content: '{}' });

const active = runHook(protectedWrite(project));
sanity.push({
  check: 'projeto temporário tem time ativo (Write em .team/state.json é bloqueado)',
  expected: 2,
  got: active.status,
  ok: active.status === 2,
});
const inactive = runHook(protectedWrite(plain));
sanity.push({
  check: 'diretório do cenário 1 não tem time em nenhum ancestral (mesma carga é liberada)',
  expected: 0,
  got: inactive.status,
  ok: inactive.status === 0,
});

// ---------- medição ----------

const results = [];
for (const scn of scenarios) {
  for (let i = 0; i < WARMUP; i++) runHook(scn.payload); // aquecimento, descartado
  const samples = [];
  const mismatches = [];
  for (let i = 0; i < RUNS; i++) {
    const r = runHook(scn.payload);
    if (r.status !== scn.expect) mismatches.push({ run: i + 1, status: r.status, stderr: r.stderr.trim().slice(0, 200) });
    samples.push(r.ms);
  }
  results.push({ ...scn, payload: undefined, ...stats(samples), mismatches, samples });
}

const byId = Object.fromEntries(results.map((r) => [r.id, r]));
const gitOverhead = byId.git.p50 - byId['read-comum'].p50;
const worstP95 = Math.max(...results.map((r) => r.p95));
const rnf03 = { limit_ms: RNF03_P95_MS, scenario: 'git', p95: byId.git.p95, ok: byId.git.p95 <= RNF03_P95_MS };
const badSanity = sanity.filter((s) => !s.ok);
const badStatus = results.filter((r) => r.mismatches.length);

// ---------- saída ----------

const env = {
  node: process.version,
  platform: `${os.platform()} ${os.release()}`,
  arch: process.arch,
  cpu: os.cpus()[0]?.model?.trim() || 'desconhecida',
  cores: os.cpus().length,
  total_mem_gb: Math.round(os.totalmem() / 1024 ** 3),
  git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
  measured_at: new Date().toISOString(),
  runs_per_scenario: RUNS,
  warmup_discarded: WARMUP,
  deploy_patterns: defaultConfig().deploy.patterns.length,
};

if (JSON_ONLY) {
  console.log(JSON.stringify({ env, sanity, rnf03, git_overhead_p50_ms: gitOverhead, scenarios: results }, null, 2));
} else {
  const line = (l, v) => console.log(`${l.padEnd(22)} ${v}`);
  console.log('# Desempenho do hook guard.mjs (PreToolUse)\n');
  line('Hook medido:', path.relative(REPO, HOOK).replace(/\\/g, '/'));
  line('Node:', env.node);
  line('Máquina:', `${env.platform} · ${env.arch} · ${env.cpu} · ${env.cores} núcleos · ${env.total_mem_gb} GB`);
  line('Git:', env.git);
  line('Execuções:', `${RUNS} por cenário, ${WARMUP} de aquecimento descartadas`);
  line('Medido em:', env.measured_at);
  console.log('\nSanidade:');
  for (const s of sanity) console.log(`  ${s.ok ? 'ok  ' : 'FALHA'} ${s.check} (exit ${s.got}, esperado ${s.expected})`);
  console.log('\n| Cenário                                          | exit | p50      | p95      | máx      | min      | média    |');
  console.log('|--------------------------------------------------|------|----------|----------|----------|----------|----------|');
  for (const r of results) {
    console.log(
      `| ${r.label.padEnd(48)} | ${String(r.expect).padStart(4)} ` +
        `| ${ms(r.p50).padStart(8)} | ${ms(r.p95).padStart(8)} | ${ms(r.max).padStart(8)} ` +
        `| ${ms(r.min).padStart(8)} | ${ms(r.mean).padStart(8)} |`,
    );
  }
  console.log(`\nCusto do caminho com git (p50 git − p50 Read): ${ms(gitOverhead)}`);
  console.log(`p95 do pior cenário: ${ms(worstP95)}`);
  console.log(`RNF-03 (p95 ≤ ${RNF03_P95_MS} ms no cenário com git): ${rnf03.ok ? 'ATENDIDO' : 'NÃO ATENDIDO'} (${ms(rnf03.p95)})`);
  for (const r of badStatus) {
    console.log(`\nATENÇÃO: ${r.id} devolveu exit inesperado em ${r.mismatches.length}/${RUNS} execuções:`);
    for (const m of r.mismatches.slice(0, 3)) console.log(`  execução ${m.run}: exit ${m.status} — ${m.stderr}`);
  }
}

// ---------- limpeza ----------

const leftovers = [];
for (const dir of tmpDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    leftovers.push(dir);
  }
}
if (leftovers.length && !JSON_ONLY) {
  console.log(`\nNão foi possível remover ${leftovers.length} diretório(s) temporário(s); remova-os manualmente se quiser.`);
}

if (badSanity.length || badStatus.length) process.exit(1);
if (GATE && !rnf03.ok) process.exit(1);
