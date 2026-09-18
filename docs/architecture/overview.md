# Visão de arquitetura — runtime do agent-team (v1.1)

Work item: W-001-evolucao-v1-1 · Data: 2026-09-17 · Status: proposto (aguarda G2)

Este documento descreve **o que existe hoje (v1.0)** e **o que muda na v1.1**. As decisões estão nos ADRs
(`adr-001` a `adr-010`); os contratos internos (CLI, hooks, config, estado, aprovações) estão em
[`contracts.md`](./contracts.md).

> Não há `docs/api/openapi.yaml` nem `docs/data/model.md` neste projeto: não existe API HTTP nem banco de
> dados. O papel desses artefatos é cumprido por `contracts.md` (contratos internos) e pela seção
> "Estado e formatos" dele (modelo de dados em arquivos JSON).

## Contexto (C4 nível 1)

```mermaid
graph LR
  U["PO/Tech Lead<br/>(usuário, digita no chat e no terminal)"]
  CC["Claude Code<br/>(harness: sessão principal + subagentes)"]
  AT["agent-team<br/>(skill + papéis + runtime Node)"]
  REPO["Projeto do usuário<br/>(git, docs/, .team/)"]

  U -->|"APROVAR G1 / REPROVAR G1 motivo"| CC
  U -->|"cria commit base, edita .team/config.json"| REPO
  CC -->|"hooks UserPromptSubmit e PreToolUse"| AT
  CC -->|"ferramentas Bash/Write/Read/Grep/Glob"| REPO
  AT -->|"lê e escreve estado, aprovações e log"| REPO
  AT -->|"bloqueia (exit 2) ou libera (exit 0)"| CC
```

## Containers e componentes (C4 nível 2, v1.1)

Em **negrito**, o que a v1.1 cria; em _itálico_, o que a v1.1 altera.

```mermaid
graph TB
  subgraph FONTE["Repositório agent-team (fonte, versionado)"]
    SRC["src/: skill orquestrar + agent-contract + 8 papéis"]
    BUILD["scripts/build.mjs → dist/"]
    INST["_scripts/install.mjs / uninstall.mjs_"]
    TESTS["tests/*.test.mjs + **tests/perf-guard.mjs**"]
  end

  subgraph INSTALADO["~/.claude (runtime instalado = produção)"]
    AG["agents/*.md, skills/orquestrar/"]
    SET["settings.json (hooks)"]
    KEY[("team/approval.key<br/>segredo HMAC")]
    subgraph RT["team/ (runtime)"]
      CLI["_bin/team.mjs_ — CLI"]
      HG["_hooks/guard.mjs_ — PreToolUse"]
      HP["_hooks/prompt-approval.mjs_ — UserPromptSubmit"]
      CORE["_lib/core.mjs_ — estado, transições, HMAC, DAG, log"]
      GR["_lib/guard-rules.mjs_ — regras do guard"]
      GIT["**lib/git.mjs** — fatos do git"]
      PTH["**lib/paths.mjs** — ancestralidade de caminhos"]
      SH["**lib/shell.mjs** — tokenização de comando"]
      PR["**lib/prompt-rules.mjs** — classificação da mensagem"]
    end
  end

  subgraph PROJ[".team/ do projeto (fora do git)"]
    CFG["config.json — gates, main_branches, deploy.patterns"]
    ST["state.json — work item, fase, tarefas"]
    APR["approvals/&lt;work&gt;/&lt;gate&gt;{,.rejected}.json"]
    LOG["logs/orchestration.jsonl"]
    WRK["work/&lt;work&gt;/ — briefs, results, context"]
  end

  BUILD --> AG
  INST --> AG & SET & RT & KEY
  CLI --> CORE
  HG --> GR
  HP --> PR --> CORE
  GR --> CORE & GIT & PTH & SH
  CLI --> GIT
  CORE --> CFG & ST & APR & LOG
  CORE -.->|"assina/verifica"| KEY
  TESTS -.->|"AGENT_TEAM_HOME temporário"| RT
```

### Responsabilidade de cada módulo

| Módulo | Responsabilidade | Muda na v1.1 |
|---|---|---|
| `lib/core.mjs` | formatos, transições, aprovações assinadas, DAG, log. **Sem git, sem regex de shell** | defaults de deploy (ADR-002), `checkApproval` (ADR-004), `defaultConfig` (ADR-008) |
| `lib/guard-rules.mjs` | decisão pura `evaluateToolCall(input) → {deny, reason}` | integra `git.mjs`/`paths.mjs`/`shell.mjs`, expõe `enforcementContext` |
| **`lib/git.mjs`** | único lugar que executa `git`; devolve fatos estruturados | novo (ADR-001) |
| **`lib/paths.mjs`** | normalização e ancestralidade de caminhos (Windows, UNC, caixa) | novo (ADR-003) |
| **`lib/shell.mjs`** | separa texto citado de metacaracteres reais | novo (ADR-009) |
| **`lib/prompt-rules.mjs`** | classifica a primeira linha da mensagem do usuário | novo (ADR-006) |
| `hooks/guard.mjs` | I/O do hook + política de falha (fail-closed escopado) | ADR-005 |
| `hooks/prompt-approval.mjs` | I/O do hook + registro da decisão + avisos | ADR-006 |
| `bin/team.mjs` | CLI: fase, tarefas, status, avisos de bootstrap | ADR-001, ADR-008 |

**Regra de dependência:** `core.mjs` não importa nada do guard; `guard-rules.mjs` importa `core.mjs` e as
libs novas; os hooks e o CLI não contêm regra de negócio, só I/O e formatação de mensagem. `git.mjs` é o
**único** módulo que chama `execFileSync`.

## Fluxo de decisão de um gate (v1.1)

```mermaid
sequenceDiagram
  actor U as Usuário
  participant H as hook UserPromptSubmit
  participant PR as prompt-rules
  participant C as core
  participant O as Orchestrator
  participant CLI as CLI team
  participant G as hook PreToolUse (guard)

  U->>H: primeira linha da mensagem
  H->>PR: classifyPrompt(primeira linha)
  alt conversa (verbo ausente ou palavras extra)
    PR-->>H: {kind:"none"}
    H--)O: stdout vazio (nada registrado)
  else decisão completa (APROVAR G1)
    PR-->>H: {kind:"decision", gate:"G1"}
    H->>C: recordDecision(root, G1, approved)
    C->>C: assina HMAC e grava approvals/<work>/G1.json
    C->>C: appendLog(actor:user, event:approved)
    H--)O: additionalContext "O USUÁRIO APROVOU G1..."
  else intenção incompleta (APROVAR / APROVAR G9)  %% ADR-006
    PR-->>H: {kind:"intent", verb:"approve"}
    H->>C: loadState (somente leitura)
    H--)O: aviso "NADA foi registrado. Digite: APROVAR G1"
  end

  O->>CLI: team move ARCHITECTING
  CLI->>C: moveTo → checkApproval(G1)
  C->>C: assinatura + decisão + reprovação mais nova? (ADR-004)
  alt aprovação válida e mais recente
    CLI-->>O: WAITING_G1_APPROVAL → ARCHITECTING
  else
    CLI-->>O: exit 3 "exige aprovação humana de G1"
  end

  Note over G: em qualquer momento, uma ferramenta do agente<br/>passa pelo guard antes de executar
  O->>G: Bash "git merge ..."
  G->>C: loadConfig/loadState/checkApproval(G3)
  G-->>O: exit 2 "[agent-team] BLOQUEADO: ..."
```

## Pontos de bloqueio do guard (v1.1)

```mermaid
flowchart TD
  A["entrada JSON no stdin"] --> B{"JSON válido?"}
  B -- não --> P0["exit 0 (CA-05.3)"]
  B -- sim --> CTX["enforcementContext: findTeamRoot + enforce"]
  CTX --> EV{"avaliar"}
  EV -->|"exceção"| ERR{"projeto com time ativo?"}
  ERR -- sim --> D0["exit 2 — erro interno do guard (ADR-005)"]
  ERR -- não --> P1["exit 0 + stderr"]
  EV --> R1{"sem .team/ ou enforce=false?"}
  R1 -- sim --> P2["exit 0"]
  R1 -- não --> R2{"ferramenta"}

  R2 -->|"Write/Edit/MultiEdit/NotebookEdit"| W{"caminho protegido?<br/>.team/{state,config,approvals,logs},<br/>runtime instalado, settings.json"}
  W -- sim --> DW["BLOQUEIA"]
  W -- não --> PW["permite"]

  R2 -->|"Read/Grep/Glob"| S["alvos = file_path / path / prefixo estático do pattern<br/>(NUNCA o texto do pattern) — ADR-003"]
  S --> S1{"Read do arquivo da chave?"}
  S1 -- sim --> DS1["BLOQUEIA"]
  S1 -- não --> S2{"Grep/Glob com alvo = chave,<br/>ancestral da chave ou dentro do runtime?"}
  S2 -- sim --> DS2["BLOQUEIA (chave)"]
  S2 -- não --> PS["permite (busca no projeto é livre)"]

  R2 -->|"Bash/PowerShell"| C1{"chamada isolada do CLI?<br/>(metacaractere fora de aspas — ADR-009)"}
  C1 -- sim --> PC["permite"]
  C1 -- não --> C2{"literal protegido no comando?"}
  C2 -- sim --> DC2["BLOQUEIA + indica Grep/Glob/Read (ADR-003)"]
  C2 -- não --> C3{"comando git/gh que altera histórico?"}
  C3 -- não --> C5
  C3 -- sim --> C4{"branch (ADR-001)"}
  C4 -->|"principal, com ou sem commits"| DC4["BLOQUEIA (G3/MERGING);<br/>sem commits: manda o usuário criar o commit base"]
  C4 -->|"indeterminada"| DC5["BLOQUEIA (branch não identificada)"]
  C4 -->|"outra branch / HEAD destacado / sem git"| C5{"casa deploy.patterns?"}
  C5 -- não --> PF["permite"]
  C5 -->|"sim + production_patterns"| DP1["exige DEPLOYING_PROD + PROD"]
  C5 -->|"sim"| DP2["exige DEPLOYING + G4"]
```

## Rastreabilidade — história/requisito → decisão

| História | RF/RNF | Decisão | Onde muda |
|---|---|---|---|
| US-01 | RF-01, RF-02 | ADR-001 | `lib/git.mjs` (novo), bloco git de `guard-rules.mjs`, `bin/team.mjs` |
| US-02 | RF-03, RF-04 | ADR-002 | `DEFAULT_DEPLOY_PATTERNS` / `DEFAULT_PRODUCTION_PATTERNS` em `core.mjs` |
| US-03 | RF-05, RF-06, RF-07 | ADR-003 | `lib/paths.mjs` (novo), bloco Read/Grep/Glob e `shellPathReason` |
| US-04 | RF-08, RF-09 | ADR-004 | `checkApproval` em `core.mjs` |
| US-05 | RF-10 | ADR-005 | `hooks/guard.mjs` + `enforcementContext` em `guard-rules.mjs` |
| US-06 | RF-11 | ADR-008 | `defaultConfig` em `core.mjs`, saída de `team init` |
| US-07 | RF-12 | ADR-009 | `lib/shell.mjs` (novo), `isStandaloneTeamCall` |
| US-08 | RF-13, RF-14 | ADR-006 | `lib/prompt-rules.mjs` (novo), `hooks/prompt-approval.mjs` |
| RNF-01 | compatibilidade | sem dependências; só `node:*`; `path` da plataforma (ADR-003) | — |
| RNF-02 | testabilidade | ADR-004 e ADR-006 listam os 2 testes existentes que mudam, com o CA que justifica | `tests/**` |
| RNF-03 | desempenho | ADR-001: 1 spawn de git no caminho comum, 2º só quando já vai bloquear; `tests/perf-guard.mjs` | — |
| RNF-04 | segurança | ADR-003 (alvo, não padrão) + ADR-005 (fail-closed escopado); nenhuma mensagem imprime a chave | — |
| RNF-05 | usabilidade | `contracts.md` §"Mensagens" fixa prefixo, idioma e próximo passo | — |
| RNF-06 | harness | (a) atendido; (b) smoke em DEPLOYING, roteiro em `contracts.md` §"Smoke" | — |
| RNF-07 | **migração** | **ADR-007** (assinatura congelada, `version` mantida, leitura tolerante) | — |
| RNF-08 | auditoria | ADR-004 (log de toda decisão) + ADR-005 (erro interno em stderr) | — |
| RNF-09 | documentação | `README.md` + `CHANGELOG.md` + `SKILL.md` §bootstrap/§CLI | fora de `runtime/` |
| RNF-10 | idioma | mensagens em português, identificadores em inglês | — |
| B-12 | mitigação | ADR-010 | `.team/config.json` deste repo (o usuário aplica) |

## Riscos arquiteturais

1. **Fail-closed pode travar o próprio conserto** (ADR-005): se a v1.1 instalada tiver um bug nas regras, todo
   projeto com time ativo bloqueia. Escape documentado: o usuário põe `"enforce": false` na config do projeto
   (edição manual, que nenhum agente consegue fazer). O smoke do RNF-06 (b) tem que exercitar exatamente isso.
2. **Configs existentes não recebem os novos `deploy.patterns`** (ADR-002/ADR-007, `loadConfig` substitui o
   array). Projetos antigos, inclusive este, continuam desprotegidos até o usuário editar a config.
3. **Ancestralidade lexical não cobre link simbólico/junction** para dentro da árvore da chave (ADR-003). É
   limite conhecido: o guard protege contra erro do modelo, não contra burla deliberada.
4. **Duas tarefas disputam `core.mjs` e quatro disputam `guard-rules.mjs`**: o plano técnico do resultado
   serializa essas tarefas em duas faixas (lanes) de arquivos disjuntos.
