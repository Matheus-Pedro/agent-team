# Runbook — instalação do agent-team

Como instalar, verificar e reverter o agent-team no diretório do Claude Code. Escrito para a v1.1.0
(work item `W-001-evolucao-v1-1`), mas vale para qualquer versão instalada por `scripts/install.mjs`.

## 1. O que é "deploy" aqui

| Ação | Onde | Classificação (ADR-002) | Quem pode executar |
|---|---|---|---|
| `node scripts/install.mjs --claude-dir <TMP>` | diretório temporário | deploy **de teste** | agente em `DEPLOYING` com G4 aprovado, ou o usuário no terminal |
| `npm run install:claude` / `node scripts/install.mjs` | `~/.claude` real | deploy **de produção** | agente em `DEPLOYING_PROD` com `APROVAR PROD`, ou o usuário no terminal |
| `npm run uninstall:claude` / `node scripts/uninstall.mjs` | `~/.claude` real | deploy de produção | idem |

- Instalar no `~/.claude` real **substitui o guard e o hook de aprovação de todas as sessões**, inclusive
  da sessão que está fazendo a instalação. Os hooks são processos `node` iniciados a cada chamada, então o
  código novo vale **na próxima chamada de ferramenta**, sem reiniciar a sessão.
- `<TMP>` **não pode conter** `prod`, `production`, `prd` nem `--prod`, que estão em `production_patterns`.
  Se contiver, o comando é tratado como produção. Sugestão: `%TEMP%\agent-team-v11-smoke`.
- No seu terminal, fora de uma sessão do Claude Code, o guard não atua.

## 2. O que o instalador faz (`scripts/install.mjs`)

1. Roda o build (`dist/`, ignorado pelo git).
2. Copia `agents/<papel>.md` e `skills/orquestrar/`.
3. Apaga e recopia `team/bin`, `team/hooks` e `team/lib`, e grava `team/VERSION` com a versão, o commit e a data.
4. **Chave de assinatura:** só gera `team/approval.key` se ela **não existir** (linhas 62-68). O passo 3
   apaga só `bin`, `hooks` e `lib`, então a chave existente nunca é tocada. O instalador da v1.0 (`86c79f9`)
   tem o mesmo código, então o rollback também preserva a chave.
5. Registra os hooks em `settings.json`. Só reescreve o arquivo, e faz backup `settings.json.bak-<data>`, se
   o conteúdo mudar. Os scripts de instalação não mudaram entre a v1.0 e a v1.1 (`git diff 86c79f9 HEAD -- scripts/`
   vazio). Com a v1.0 já instalada, o `settings.json` fica igual e nenhum backup é criado.

### Se a chave for perdida
As aprovações são HMAC com essa chave. Sem ela, o instalador gera uma chave nova e **todas as aprovações
já registradas deixam de valer** (`assinatura inválida`) em todos os projetos: G1 a G4 e PROD do work item
em andamento. O guard passa a bloquear o deploy e as transições que exigem gate. Nada no runtime reconstrói
a chave nem reassina registros. Nenhum agente lê, copia ou rotaciona a chave. Se quiser um backup, faça você
mesmo, no seu terminal, e guarde-o fora de repositórios.

## 3. Pré-requisitos

- Node ≥ 20.11 e git.
- `npm test` verde na árvore que será instalada (v1.1: 125/125, `TT2-quality-gate-reteste.md`).
- Árvore limpa em `main` no commit a instalar (`git status`, `git log -1`).
- O projeto em andamento já tem os padrões do ADR-010 em `.team/config.json` (conferido: `deploy.patterns` e
  `production_patterns` com os itens do agent-team).

## 4. Etapa 1: instalação em diretório temporário (gate G4, estado `DEPLOYING`)

Não afeta nenhuma sessão: o `settings.json` gerado fica em `<TMP>` e nenhum Claude Code o lê.

```bash
T="C:/Users/<você>/AppData/Local/Temp/agent-team-v11-smoke"   # sem "prod" no caminho
node scripts/install.mjs --claude-dir "$T" --dry-run
node scripts/install.mjs --claude-dir "$T"
cat "$T/team/VERSION"                  # esperado: 1.1.0 (<commit>) ...
ls "$T/agents" "$T/skills/orquestrar" "$T/team/bin" "$T/team/hooks" "$T/team/lib"
```

Esperado: 8 agentes, a skill, `team.mjs`, `guard.mjs`, `prompt-approval.mjs` e os 5 módulos de `lib`
(`core`, `git`, `guard-rules`, `paths`, `prompt-rules`). O `$T/settings.json` tem um `UserPromptSubmit` e
um `PreToolUse` apontando para `$T/team/hooks/`.

### Smoke no nível do hook (o agente consegue fazer)
Roda o runtime **instalado em `$T`**, com chave própria (`AGENT_TEAM_HOME="$T/team"`), num projeto
descartável. Não usa o `.team/` real nem a chave real. Prova o mecanismo (a), (b), (c) e o item 4 do
`contracts.md` §7, mas **não substitui** o smoke em sessão real.

Regras que o guard em vigor impõe a este smoke (aprendidas na execução de 2026-09-18):
- **Nunca** use o shell sobre as pastas de aprovações e de logs, nem mesmo as do projeto descartável. Não
  cite esses nomes no comando (`ls`, `find`, `cat`...). O guard bloqueia com `aprovações e logs não podem ser
  manipulados via shell`. Verifique o efeito pelo **CLI instalado** (`status --json`, `move`) ou pelas
  ferramentas **Read**/**Glob**.
- Invoque cada hook num **comando próprio**, com o JSON vindo de um arquivo por redirecionamento de stdin.
- Escreva os JSON com a ferramenta de escrita (Write), não no texto do comando. O guard em vigor avalia o
  texto do comando e bloquearia `git merge` e `.claude/team` citados nele.
- Um `[agent-team] BLOQUEADO` impresso pelo **hook do temporário** é o resultado esperado de um caso de
  teste. Um bloqueio do **guard em vigor** (mensagem `PreToolUse:Bash hook error`) exige parar e reportar.

1. Projeto descartável (fora de `$T/team`, por exemplo, ao lado de `$T`):
   ```bash
   export AGENT_TEAM_HOME="$T/team"; P="<scratch>/v11proj"; CLI="$T/team/bin/team.mjs"
   git init -q -b main "$P"
   git -C "$P" -c user.email=smoke@example.invalid -c user.name=smoke commit -q --allow-empty -m base
   git -C "$P" checkout -q -b team/smoke
   node "$CLI" init --root "$P"
   node "$CLI" start smoke --track G --root "$P"
   node "$CLI" move WAITING_G1_APPROVAL --root "$P"
   ```
2. Entradas JSON em `<scratch>/v11in/` (`cwd` = `<P>` em todas):
   - `aprovar-incompleto.json`: `{"hook_event_name":"UserPromptSubmit","cwd":"<P>","prompt":"APROVAR"}`
   - `aprovar-g1.json`: idem com `"prompt":"APROVAR G1"`
   - `merge.json`: `PreToolUse`, `Bash`, `{"command":"git checkout main && git merge team/smoke"}`
   - `grep-projeto.json`: `Grep`, `{"pattern":".claude/team","path":"<P>"}`
   - `grep-runtime.json`: `Grep`, `{"pattern":"x","path":"<T>/team"}`
   - `cli-controle.json`: `PowerShell`, `{"command":"node \"$HOME/.claude/team/bin/team.mjs\" status"}`
   - `cli-parenteses.json`: `PowerShell`, `{"command":"node \"$HOME/.claude/team/bin/team.mjs\" log nota --msg \"a\" (Write-Output INJETADO)"}`

   Nos dois casos de CLI, o caminho **tem de ser o canônico** `.claude/team/bin/team.mjs`. A lista branca e a
   regra dos metacaracteres (`guard-rules.mjs`, `TEAM_CLI_RE`) só reconhecem esse caminho. Com o caminho do
   temporário (`$T/team/bin/team.mjs`), o guard vê um `node` comum e libera (exit 0), e o teste não prova
   nada. O guard só avalia o texto, então o arquivo não precisa existir.
3. Execute um comando por linha, sempre com `AGENT_TEAM_HOME="$T/team"`, e confira:

| # | Comando | Esperado | Verificação do efeito |
|---|---|---|---|
| 3 | `node "$T/team/hooks/prompt-approval.mjs" < aprovar-incompleto.json` | exit 0; aviso `Você digitou "APROVAR", mas NADA foi aprovado ... Digite exatamente: APROVAR G1` | `node "$CLI" status --json --root "$P"` → `G1.approved = false` |
| 4 | `node "$T/team/hooks/prompt-approval.mjs" < aprovar-g1.json` | exit 0; `O USUÁRIO APROVOU G1 ...` | `status --json` → `G1.approved = true`; `node "$CLI" move ARCHITECTING --root "$P"` → exit 0; Glob `.team/**/*.json` em `$P` mostra `G1.json` |
| 5 | `node "$T/team/hooks/guard.mjs" < merge.json` | exit 2; `BLOQUEADO: merge na branch principal só é permitido no estado MERGING ...` | — |
| 6a | `node "$T/team/hooks/guard.mjs" < grep-projeto.json` | exit 0 | — |
| 6b | `node "$T/team/hooks/guard.mjs" < grep-runtime.json` | exit 2; `busca cujo alvo alcança a chave ...` | — |
| 7a | `node "$T/team/hooks/guard.mjs" < cli-controle.json` | exit 0 | — |
| 7b | `node "$T/team/hooks/guard.mjs" < cli-parenteses.json` | exit 2; `o runtime do time só pode ser usado como comando isolado ...` | — |

Aqui a "aprovação" é simulada pelo agente num projeto e com uma chave descartáveis, como nos testes
automatizados. Ela não vale como aprovação de nada e não substitui o item (a) numa sessão real.

Limpeza: apague `$T`, `<P>` e a pasta dos JSON (`rm -rf`). `$T` contém uma chave descartável, e nenhuma
dessas pastas tem dado do usuário.

## 5. Etapa 2: instalação no `~/.claude` real (gate PROD, estado `DEPLOYING_PROD`)

Pré-checagens:
- A etapa 1 e o smoke no nível do hook passaram, com a evidência registrada.
- Nenhuma outra sessão do Claude Code está no meio de uma ação. Durante a cópia, `team/hooks` e `team/lib`
  somem por alguns milissegundos. Uma chamada de ferramenta nesse intervalo teria erro de hook, sem bloqueio.
- A instalação é **uma chamada isolada**, sem chamadas de ferramenta em paralelo.

```bash
node scripts/install.mjs --dry-run      # esperado: atualizar agents, instalar skill e runtime,
                                        # "hooks já registrados em settings.json (sem mudanças)",
                                        # e SEM a linha "gerar team/approval.key"
npm run install:claude
```

Se o dry-run listar `gerar team/approval.key`, **pare**: a chave não está onde deveria. Instalar geraria uma
chave nova e invalidaria as aprovações (seção 2).

### Verificação pós-instalação
Pelo agente, na sessão do work item, na chamada seguinte à instalação:
1. `node "$HOME/.claude/team/bin/team.mjs" status --json`: estado `DEPLOYING_PROD`, G1, G2, G3, G4 e PROD
   aprovados, e a chave nova `git` presente (prova que é o CLI da v1.1). Item 5 do §7.
2. O próprio fato de a chamada acima passar pelo guard prova que o guard da v1.1 carregou sem erro interno.
3. Um comando que deve ser bloqueado, por exemplo `git merge` fora de `MERGING`, devolve `[agent-team] BLOQUEADO:`. Item (c).

Pelo **usuário**, em sessão real. Só a mensagem do usuário dispara o `UserPromptSubmit`, e o work item
real já não tem gate em espera. Por isso o roteiro usa um projeto descartável:
1. No seu terminal: crie uma pasta, `git init -b main`, `git commit --allow-empty -m base`,
   `git checkout -b team/smoke`, e depois `node ~/.claude/team/bin/team.mjs init`,
   `... start smoke --track G` e `... move WAITING_G1_APPROVAL`.
2. Abra uma sessão do Claude Code nessa pasta e envie só `APROVAR`. Esperado: aviso da US-08 com o gate
   em espera e o comando exato `APROVAR G1`, sem nada registrado. Item (b).
3. Envie `APROVAR G1`. Esperado: o contexto `O USUÁRIO APROVOU G1` chega à sessão, e `team status --json`
   mostra G1 aprovado. Item (a).
4. Peça ao agente para rodar `git merge main`. Esperado: `[agent-team] BLOQUEADO:`. Item (c).
5. Registre a evidência em `.team/work/<id>/results/` do work item de origem e apague a pasta descartável.

## 6. Rollback para a v1.0 (`86c79f9`)

**Gatilhos** (qualquer um):
- `[agent-team] BLOQUEADO: erro interno do guard ...` em ações comuns (US-05, fail-closed);
- erro de hook (`PreToolUse` ou `UserPromptSubmit`) em toda chamada;
- `team status --json` mostra como inválida uma aprovação que era válida antes da instalação;
- `APROVAR Gx` correto não registra, ou o aviso da US-08 não aparece;
- um comando que deveria ser bloqueado passa;
- `team/VERSION` não mostra a versão e o commit esperados.

**Passos**, no **terminal do usuário**. Um guard quebrado pode bloquear o agente, e reinstalar no diretório
real é produção:
```bash
git -C <repo> worktree add "<TMP>/agent-team-v1.0" 86c79f9
cd "<TMP>/agent-team-v1.0"
npm run install:claude           # instalador da v1.0: mesmo código, preserva a chave
cat ~/.claude/team/VERSION       # esperado: 0.1.0 (86c79f9) ...
cd - && git -C <repo> worktree remove "<TMP>/agent-team-v1.0"
```
- Não use `git checkout 86c79f9` no repositório principal: a worktree evita mexer em `main`.
- Os dados de `.team/` escritos pela v1.1 continuam legíveis pela v1.0. Os formatos foram congelados (ADR-007,
  regras 1 a 5), e não há conversão.
- Consequência: voltam os comportamentos da v1.0. Não há aviso da US-08, o guard libera quando falha e
  arquivos `*.rejected.json` são ignorados, ou seja, a regra "vale a última decisão" (US-04) deixa de valer.
  Os padrões do ADR-010 em `.team/config.json` continuam protegendo este repositório.
- Se nem o rollback puder rodar: coloque `"enforce": false` no `.team/config.json` do projeto travado (só o
  usuário pode). Como último recurso, restaure um `~/.claude/settings.json.bak-*`.

## 7. Depois do deploy

- **CHANGELOG:** a entrada `## [1.1.0] - não publicada` recebe a data da instalação real
  (`## [1.1.0] - AAAA-MM-DD`) **só depois** de o smoke da etapa 2 passar, na transição para `DEPLOYED`.
  Quem edita é o papel documentation, ou o usuário. Quem commita é o Orchestrator ou o usuário, pelo fluxo
  normal, nunca direto na `main` por um agente. Se houver rollback, a entrada continua "não publicada".
- O `team/VERSION` instalado aponta para o commit instalado (por exemplo `59541c2`), não para o commit que
  só data o CHANGELOG. Isso é esperado.
