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

Instale e remova **no seu terminal**. Dentro de um projeto com time ativo, o guard trata a instalação e a remoção feitas por um agente como deploy (veja [O que o runtime garante](#o-que-o-runtime-garante)).

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
| `REPROVAR G2 <motivo>` (ou `REPROVAR G2: <motivo>`, `REPROVAR G2, <motivo>`) | registra a reprovação; o Orchestrator volta à fase com o motivo |
| `APROVAR` (sem gate), `APROVADO`, `APROVAR G9`, `REPROVAR` | **nada é registrado**; com work item ativo, você recebe um aviso com o gate que está aguardando e o comando exato a digitar |
| `ok`, `pode seguir`, 👍 | **não é aprovação** (e não gera aviso) |
| `APROVAR G1?`, `APROVAR G1;`, `REPROVAR G1; <motivo>` | **conversa**: nada é registrado e não há aviso. No fim da linha, só `. ! : ,` e `…` são aceitos |

Vale a **última** decisão: se você aprovar e depois reprovar o mesmo gate antes de o fluxo avançar, a aprovação deixa de valer (e vice-versa).

Para retomar depois, digite `/orquestrar` de novo. O estado está em `.team/`.

### Primeiro uso num repositório novo (bootstrap)

A branch do work item sai de um commit da branch principal. Num repositório **sem commits**, esse commit base não existe, e ele é criado **por você, no seu terminal**: os agentes não commitam na principal, e o guard bloqueia um `git commit` de agente numa principal sem commits.

1. O Orchestrator roda `team init`. A saída lista os gates ligados em cada trilha e, se a branch atual for uma das `main_branches` e ainda não tiver commits, mostra o aviso `⚠️ Este repositório ainda não tem o commit base em <branch>...`.
2. Você cria o commit base no seu terminal (por exemplo, `git add` dos arquivos do projeto e `git commit`).
3. O Orchestrator cria a branch do work item a partir desse commit.

Enquanto o commit base não existir, `team status` repete o aviso (no `--json`, na chave `git.warnings`). Se o git não conseguir identificar a branch atual, o aviso diz isso, e o guard bloqueia comandos que alteram histórico até o problema ser resolvido. Fora de um repositório git, não há aviso.

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
    "P": { "G1": false, "G2": false, "G3": true, "G4": true },
    "M": { "G1": true, "G2": true, "G3": true, "G4": true },
    "G": { "G1": true, "G2": true, "G3": true, "G4": true }
  },
  "deploy": {
    "patterns": ["\\bdocker\\s+push\\b", "..."],     // regex de comandos considerados deploy
    "production_patterns": ["--prod\\b", "..."]      // regex que marcam o deploy como produção
  }
}
```

Projetos novos nascem com a trilha P **sem G1 e G2**: um bugfix não aprova requisitos nem arquitetura, mas continua passando por G3 (merge), G4 (deploy) e PROD. As trilhas M e G têm todos os gates ligados. Para exigir G1 e G2 também na trilha P, mude os dois para `true`.

Os padrões de deploy já incluem a instalação e a remoção do agent-team (`install:claude`, `uninstall:claude`, `node .../scripts/install.mjs` e `node .../scripts/uninstall.mjs`). Sem `--claude-dir`, esses comandos contam como **produção**.

### Projetos que já têm `.team/` (atualização da v1.0)

Instalar a v1.1 **não altera** a config de projetos já inicializados. O `team init` grava os gates e os padrões de deploy por inteiro, e os valores da sua config **substituem** os padrões do código (os arrays não são somados). Por isso, um projeto criado com a v1.0 continua com todos os gates ligados na trilha P e **sem a proteção contra instalar ou remover o agent-team**.

Para receber as proteções novas, edite `.team/config.json` no seu editor e **acrescente** aos arrays existentes, sem remover nada:

```jsonc
"deploy": {
  "patterns": [
    // ... os que já estão lá ...
    "\\b(un)?install:claude\\b",
    "\\bnode(\\.exe)?\\s+\\S*scripts/(un)?install\\.mjs"
  ],
  "production_patterns": [
    // ... os que já estão lá ...
    "^(?!.*--claude-dir).*(\\b(un)?install:claude\\b|\\bnode(\\.exe)?\\s+\\S*scripts/(un)?install\\.mjs)"
  ]
}
```

Opcional: para a trilha P mais leve, troque `"P"` por `{ "G1": false, "G2": false, "G3": true, "G4": true }`.

O estado, as aprovações já assinadas e o log da v1.0 continuam válidos na v1.1 ([ADR-007](docs/architecture/adr-007-compatibilidade-e-migracao-v1-0-para-v1-1.md)).

### Se o guard travar o projeto

Com a v1.1, um erro interno do guard **bloqueia** a ação num projeto com time ativo (em vez de liberá-la sem aviso). Se isso impedir o trabalho, a saída é você editar `.team/config.json` e colocar `"enforce": false`, que desliga o guard só nesse projeto. Nenhum agente pode fazer essa edição. Depois de corrigir ou reinstalar o runtime, volte para `"enforce": true`.

## O que o runtime garante

**Hook `UserPromptSubmit`** (`runtime/hooks/prompt-approval.mjs`):
- só roda quando **você** envia uma mensagem;
- registra `APROVAR/REPROVAR` em `.team/approvals/<work>/`, com HMAC;
- aceita a decisão somente se o estado for `WAITING_<gate>_APPROVAL`;
- **avisa quando a decisão vem incompleta**: se a primeira linha tiver só o verbo de decisão (`APROVAR`, `APROVO`, `APROVADO`, `REPROVAR`, `REPROVO`, `REJEITAR`, `REJEITO`) sem gate, ou com um gate inválido (`G9`, `GX`), nada é registrado e a sessão recebe um aviso `[agent-team] ⚠️ ... NADA foi aprovado nem reprovado`, com o gate que está aguardando e o comando exato. Sem work item ativo, fica em silêncio. Mensagens de conversa continuam sem aviso.

**CLI `team`** (`runtime/bin/team.mjs`):
- é o único caminho para mudar `.team/state.json`;
- valida transições e aprovações (assinatura, work item, revogação por retrabalho);
- considera a **decisão mais recente** do usuário sobre cada gate: uma reprovação assinada posterior à aprovação anula essa aprovação, e uma aprovação posterior à reprovação volta a valer. Em empate de horário, vale a reprovação. As duas decisões ficam no log de auditoria;
- avisa, em `team init` e `team status`, quando falta o commit base na principal ou a branch não pode ser identificada (veja [bootstrap](#primeiro-uso-num-repositório-novo-bootstrap));
- controla o DAG (`task add/set/ready`) e o limite de retrabalho.

**Hook `PreToolUse`** (`runtime/hooks/guard.mjs`), ativo só em projetos com `.team/`, bloqueia o agente de:
- editar estado, config, aprovações, logs, o runtime instalado ou `settings.json`;
- ler a chave de assinatura, inclusive por uma busca (Grep/Glob) cujo **alvo** alcance a chave: o arquivo, o diretório do runtime instalado ou qualquer diretório acima dela (`~/.claude`, `~`, a raiz do disco);
- apagar `.team/` (inclusive via `git clean -x`);
- fazer merge, push, commit ou rebase na branch principal fora de `MERGING` com G3 aprovado. Isso vale também para uma principal **ainda sem commits**. Se a branch atual não puder ser identificada, qualquer comando que altere histórico é bloqueado;
- rodar comandos de deploy fora de `DEPLOYING` com G4, ou de produção fora de `DEPLOYING_PROD` com `APROVAR PROD`. **Instalar ou desinstalar o agent-team é deploy**: com `--claude-dir <dir>` exige G4; no diretório real do usuário (sem `--claude-dir`) é produção e exige `APROVAR PROD`. Isso vale para projetos criados com a v1.1; em projetos antigos, veja [a atualização da config](#projetos-que-já-têm-team-atualização-da-v10).

Outras regras do guard:
- **Buscas são avaliadas pelo alvo, não pelo texto do padrão.** Um Grep ou Glob no projeto pode procurar qualquer texto, inclusive `approval.key`, `.claude/team` ou `.team/state.json`. No shell, citar esses nomes continua bloqueado, e a mensagem indica usar Grep, Glob ou Read.
- **Fail-closed escopado:** se o guard tiver um erro interno num projeto com time ativo (`enforce` diferente de `false`), a ação é bloqueada, com `[agent-team] BLOQUEADO: erro interno do guard ...`. Fora de projetos com time, ou com `enforce: false`, o erro vai para o stderr e a ação passa. A saída para um guard quebrado está em [Se o guard travar o projeto](#se-o-guard-travar-o-projeto).

O log de auditoria fica em `.team/logs/orchestration.jsonl`, com o `actor` (`user` ou `orchestrator`) de cada evento.

### Limites (seja honesto com o que isso protege)

- É uma barreira contra **erro e alucinação do modelo**, não um sandbox contra alguém burlando de propósito. A detecção de comandos é por padrões (regex), e um script arbitrário poderia fazer o que o padrão não reconhece.
- A detecção de deploy depende de `deploy.patterns`. Ajuste-os para o seu provedor. Proteção real de produção também deve existir no provedor (environments com aprovação, branch protection).
- **Você, no seu terminal, não passa pelos hooks.** Merge e deploy manuais continuam livres.
- A aprovação vale para o *estado* do work item, não para um hash dos artefatos. Se um documento mudar depois do gate sem retrabalho formal, o runtime não detecta (evolução prevista).
- **Projetos no WSL** (`\\wsl.localhost\...`): se a sessão do Claude Code rodar *dentro* do WSL, `~/.claude` é o do Linux. Nesse caso, instale lá também (`node scripts/install.mjs` executado no WSL, com Node instalado).
- **Caminhos UNC** (`\\servidor\share`, `\\wsl.localhost\...`) não foram testados com um share real. Se o git falhar nesse caminho, a branch conta como não identificada e o guard bloqueia comandos que alteram histórico.
- **Buscas pelo alvo são comparações de caminho** ([ADR-003](docs/architecture/adr-003-buscas-avaliadas-pelo-alvo.md)). Antes de comparar, o guard reconhece estas outras formas de escrever o mesmo caminho no Windows:
  - os prefixos `\\?\`, `\\.\` (também com `/`), `\\?\UNC\` e `\\.\UNC\`;
  - o compartilhamento administrativo da própria máquina: `\\localhost\c$\...`, `\\127.0.0.1\c$\...`, `\\::1\c$\...` e `\\<nome da máquina>\c$\...`;
  - nomes curtos 8.3 (como `CLAUDE~1`), expandidos pelo sistema de arquivos quando o caminho tem `~` seguido de dígito. Se não der para expandir, a chamada é **bloqueada**, com a orientação de repetir usando o caminho completo.

  Como defesa extra, um Read de qualquer arquivo com o nome do arquivo da chave é bloqueado em qualquer diretório. Grep e Glob também são bloqueados quando o alvo tem esse nome ou parece ser o runtime instalado (`.claude` ou `CLAUDE~N` seguido de `team`).

  **Continuam fora:**
  - link simbólico e junction que apontem para a árvore da chave;
  - compartilhamentos que não sejam o administrativo da própria máquina: share nomeado, nome com domínio (FQDN) ou outro IP da máquina;
  - um nome 8.3 escrito sem `~` seguido de dígito.
- **Um `--claude-dir` em qualquer lugar da linha de comando** rebaixa a instalação de produção (PROD) para deploy de teste (G4). O comando continua exigindo `DEPLOYING` com G4.
- **Buscas com alvo em `~` ou `~/.claude` agora são bloqueadas**, mesmo quando o objetivo é legítimo (por exemplo, procurar a config do Claude Code), porque esses diretórios contêm a chave. Restrinja o alvo a um subdiretório que não a contenha.
- **A chamada do CLI `team` feita por um agente não aceita metacaractere nenhum** (`;`, `&`, `|`, `<`, `>`, `` ` ``, `(`, `)`, `$(` e quebra de linha), nem mesmo entre aspas. É uma lista branca deliberadamente estreita, e o preço é o falso positivo: um título como `--title "Evolução (v1.1)"` é recusado, e o Orchestrator precisa reescrevê-lo. Você, no seu terminal, não passa por essa regra.
- **Aliases exóticos de um diretório acima da chave** — um volume pelo GUID (`\\?\Volume{...}\...`) ou uma letra de unidade criada com `subst` — só são reconhecidos quando o caminho contém `.claude\team`. Um alvo assim que aponte para um ancestral da chave, sem esse trecho no caminho, não é detectado.
- **Instalação como deploy** depende de padrões de texto ([ADR-002](docs/architecture/adr-002-instalacao-como-deploy-e-producao.md)): um caminho com espaços (`node "C:/meus projetos/scripts/install.mjs"`) não casa com o padrão, e copiar o runtime à mão também não. A escrita direta no runtime instalado continua bloqueada. Em outros projetos, um `scripts/install.mjs` executado via `node` também é classificado como deploy (falso positivo); ajuste `deploy.patterns` se for o caso. `--dry-run` do instalador também é bloqueado fora de `DEPLOYING`.
- **`APROVAR G1 <texto extra>` na mesma linha não registra nada e não gera aviso**, porque a linha é tratada como conversa ([ADR-006](docs/architecture/adr-006-aviso-de-decisao-de-gate-incompleta.md)). Coloque observações nas linhas seguintes.
- **Linhas terminadas em `?` ou `;` também são conversa:** `APROVAR G1?`, `APROVAR G1;` e `APROVAR?` não registram nada **e não geram aviso**, para que uma pergunta nunca vire aprovação. Pelo mesmo motivo, `REPROVAR G1; motivo` não registra a reprovação (na v1.0, registrava). Use `REPROVAR G1: motivo`, `REPROVAR G1, motivo` ou `REPROVAR G1 motivo`.
- **Desenvolvimento do próprio agent-team** ([ADR-010](docs/architecture/adr-010-seguranca-do-dogfooding-neste-repositorio.md)): o código do runtime em desenvolvimento usa o `.team/` e a chave reais se for executado diretamente. Neste repositório, a config bloqueia `node runtime/bin/team.mjs` e `node runtime/hooks/*.mjs`, mas **não** cobre `node -e` nem um script que importe a lib. Exercite o runtime só pelos testes (`npm test`), que usam `AGENT_TEAM_HOME` e projeto temporários. A solução estrutural fica para a v2.
- **Guard quebrado bloqueia:** como o erro interno agora bloqueia a ação (fail-closed), um bug determinístico no runtime instalado pode parar o projeto até você usar `enforce: false`.

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
  lib/git.mjs                   branch atual e commit base (único ponto que executa git)
  lib/paths.mjs                 comparação de caminhos (alvo das buscas)
  lib/prompt-rules.mjs          reconhecimento de APROVAR/REPROVAR
scripts/                        build, install, uninstall
tests/                          node:test (runtime, hooks, instalação)
```

## Evolução (v2)

- Agentes: `database` (performance e tuning), `security`, `mobile`, `data`.
- Aprovação ligada ao hash dos artefatos aprovados (invalida se o documento mudar).
- Guard ciente do agente (restringir escrita por papel, por exemplo product só em `docs/requirements/`).
- Métricas por work item: tempo por fase, retrabalhos e tokens.
