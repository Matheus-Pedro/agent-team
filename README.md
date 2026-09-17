# agent-team

Um time de agentes para o **Claude Code**, com um Orchestrator que coordena especialistas por meio de um DAG de tarefas, estado persistente e **gates de aprovação humana que o modelo não consegue pular**.

Você atua como **PO/Tech Lead**. Os agentes executam o ciclo e param para você aprovar requisitos, arquitetura, merge e deploy.

```
                    🧠 ORCHESTRATOR  (skill /orquestrar, sessão principal)
                 ┌──────────┬───────────┴───────┬──────────────┬──────────────┐
             PRODUCT     ARCHITECT       BACKEND · FRONTEND   QUALITY        DELIVERY
             product     architect       backend, frontend    qa-engineer    devops
                                                              code-reviewer  documentation
```

## Por que é assim

| Decisão | Motivo |
|---|---|
| Orchestrator é uma **skill**, não um subagente | No Claude Code, subagente não chama subagente. Quem coordena precisa ser a sessão principal. |
| Agentes separados por **fronteira** (contexto, permissão, paralelismo), não por cargo | Cada passagem entre agentes perde contexto e custa tokens. Database fica com architect (modelo) e backend (migrations); QA + automação ficam num só agente. |
| **3 camadas de prompt** | `SKILL.md` (orchestrator) + `src/common/agent-contract.md` (regras comuns) + `src/roles/*.md` (papel). O build concatena, então nada se repete. |
| **Contratos** (Input / Responsabilidades / Não pode / Output / Pronto quando) | Agentes viram componentes previsíveis, e o resultado tem formato fixo com `status`. |
| Estado em **disco** | `docs/` guarda o conhecimento permanente (versionado); `.team/` guarda o estado operacional (fora do git). A memória da LLM não é fonte da verdade. |
| **Aprovação é transição de estado real** | Só um hook disparado pela *sua mensagem* registra aprovação, com assinatura HMAC. O CLI recusa avançar sem ela, e o guard bloqueia merge e deploy fora da fase. |
| **Contrato antes de paralelismo** | Backend e frontend rodam em paralelo só depois do contrato da API aprovado no G2. |
| **Docs antes do merge** | A documentação entra no mesmo merge do código, e não depois do deploy. |

## Instalação

Requisitos: Node ≥ 20.11 e git.

```bash
npm test
```

```bash
node scripts/install.mjs --dry-run
```

```bash
npm run install:claude
```

O instalador:
- copia os agentes para `~/.claude/agents/`, a skill para `~/.claude/skills/orquestrar/` e o runtime para `~/.claude/team/`;
- gera `~/.claude/team/approval.key`;
- registra os hooks em `~/.claude/settings.json`, com backup `settings.json.bak-*`.

Reinstalar é seguro: não duplica hooks e mantém a chave.

Para remover (mantém a chave): `npm run uninstall:claude`.

> **Fluxo de edição:** edite sempre em `src/` ou `runtime/` e rode `npm run install:claude`. Os arquivos em `~/.claude/` são gerados e o guard impede o agente de editá-los durante um fluxo.

## Uso

Numa sessão aberta na raiz do projeto:

```
/orquestrar Preciso de um sistema de controle de estoque
```

O Orchestrator:
1. Roda `team init` (se for a primeira vez) e `team start`, e escolhe a trilha (P, M ou G).
2. Planeja o DAG em `.team/work/<id>/plan.md` e delega aos agentes.
3. Para em cada gate com um **pacote de aprovação**.

Para responder a um gate, a primeira linha da sua mensagem deve ser exatamente o comando:

| Você digita | Efeito |
|---|---|
| `APROVAR G1` · `G2` · `G3` · `G4` · `PROD` | registra a aprovação assinada; linhas seguintes viram observações |
| `REPROVAR G2 <motivo>` | registra a reprovação; o Orchestrator volta à fase com o motivo |
| `ok`, `pode seguir`, 👍 | **não é aprovação** |

Para retomar depois, digite `/orquestrar` de novo. O estado está em `.team/`.

### Fluxo

```
PLANNING ─▶ ⏸G1 ─▶ ARCHITECTING ─▶ ⏸G2 ─▶ IMPLEMENTING ─▶ TESTING ─▶ REVIEWING ─▶ ⏸G3 ─▶ MERGING ─▶ MERGED
   ─▶ PREPARING_DEPLOY ─▶ ⏸G4 ─▶ DEPLOYING ─▶ (⏸PROD ─▶ DEPLOYING_PROD) ─▶ DEPLOYED ─▶ DONE
```

- **Retrabalho** volta de fase. Por exemplo, "a arquitetura não suporta X" leva de IMPLEMENTING para ARCHITECTING, e isso **revoga** as aprovações posteriores (neste caso, o G2 precisa ser aprovado de novo).
- **Limite de correções:** 2 por tarefa (`max_rework_attempts`). Depois disso, o Orchestrator escala para você.

### Trilhas

| Trilha | Quando |
|---|---|
| P | bug ou ajuste pequeno |
| M | feature em sistema existente |
| G | sistema novo, épico ou mudança estrutural |

Os gates de cada trilha vêm da config do projeto.

## Configuração por projeto — `.team/config.json`

Criada pelo `team init`. **Só você edita**, no seu editor; o guard impede o agente de editar.

```jsonc
{
  "enforce": true,                        // false desliga o guard neste projeto
  "main_branches": ["main", "master"],
  "max_rework_attempts": 2,
  "gates": {                              // por trilha; PROD não é configurável (sempre exige aprovação)
    "P": { "G1": true, "G2": true, "G3": true, "G4": true },
    "M": { "G1": true, "G2": true, "G3": true, "G4": true },
    "G": { "G1": true, "G2": true, "G3": true, "G4": true }
  },
  "deploy": {
    "patterns": ["\\bdocker\\s+push\\b", "..."],     // regex de comandos considerados deploy
    "production_patterns": ["--prod\\b", "..."]      // regex que marcam o deploy como produção
  }
}
```

Exemplo: para correções pequenas sem G1 e G2, use `"P": { "G1": false, "G2": false, "G3": true, "G4": true }`.

## O que o runtime garante

**Hook `UserPromptSubmit`** (`runtime/hooks/prompt-approval.mjs`):
- só roda quando **você** envia uma mensagem;
- registra `APROVAR/REPROVAR` em `.team/approvals/<work>/`, com HMAC;
- aceita a decisão somente se o estado for `WAITING_<gate>_APPROVAL`.

**CLI `team`** (`runtime/bin/team.mjs`):
- é o único caminho para mudar `.team/state.json`;
- valida transições e aprovações (assinatura, work item, revogação por retrabalho);
- controla o DAG (`task add/set/ready`) e o limite de retrabalho.

**Hook `PreToolUse`** (`runtime/hooks/guard.mjs`), ativo só em projetos com `.team/`, bloqueia o agente de:
- editar estado, config, aprovações, logs, o runtime instalado ou `settings.json`;
- ler a chave de assinatura;
- apagar `.team/` (inclusive via `git clean -x`);
- fazer merge, push, commit ou rebase na branch principal fora de `MERGING` com G3 aprovado;
- rodar comandos de deploy fora de `DEPLOYING` com G4, ou de produção fora de `DEPLOYING_PROD` com `APROVAR PROD`.

O log de auditoria fica em `.team/logs/orchestration.jsonl`, com o `actor` (`user` ou `orchestrator`) de cada evento.

### Limites (seja honesto com o que isso protege)

- É uma barreira contra **erro e alucinação do modelo**, não um sandbox contra alguém burlando de propósito. A detecção de comandos é por padrões (regex), e um script arbitrário poderia fazer o que o padrão não reconhece.
- A detecção de deploy depende de `deploy.patterns`. Ajuste-os para o seu provedor. Proteção real de produção também deve existir no provedor (environments com aprovação, branch protection).
- **Você, no seu terminal, não passa pelos hooks.** Merge e deploy manuais continuam livres.
- A aprovação vale para o *estado* do work item, não para um hash dos artefatos. Se um documento mudar depois do gate sem retrabalho formal, o runtime não detecta (evolução prevista).
- **Projetos no WSL** (`\\wsl.localhost\...`): se a sessão do Claude Code rodar *dentro* do WSL, `~/.claude` é o do Linux. Nesse caso, instale lá também (`node scripts/install.mjs` executado no WSL, com Node instalado).

## Estrutura

```
src/
  common/agent-contract.md      regras comuns (camada 2)
  roles/*.md                    papéis com contrato (camada 3)
  skills/orquestrar/            orchestrator (camada 1) + templates
runtime/
  bin/team.mjs                  CLI de estado e DAG
  hooks/prompt-approval.mjs     registro de aprovações (UserPromptSubmit)
  hooks/guard.mjs               bloqueios (PreToolUse)
  lib/core.mjs                  máquina de estados, HMAC, DAG, log
  lib/guard-rules.mjs           regras do guard
scripts/                        build, install, uninstall
tests/                          node:test (runtime, hooks, instalação)
```

## Evolução (v2)

- Agentes: `database` (performance e tuning), `security`, `mobile`, `data`.
- Aprovação ligada ao hash dos artefatos aprovados (invalida se o documento mudar).
- Guard ciente do agente (restringir escrita por papel, por exemplo product só em `docs/requirements/`).
- Métricas por work item: tempo por fase, retrabalhos e tokens.
