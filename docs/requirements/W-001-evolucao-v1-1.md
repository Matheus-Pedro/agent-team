# Evolução do agent-team v1.1 (dogfooding) — Requisitos
Work item: W-001-evolucao-v1-1 · Status: Aprovado no G1 em 2026-09-17 · Versão: 2 · Data: 2026-09-17

> **Diferença da versão 1 (aprovada no G1):** entrou o item B-18 e a história US-08, achados durante o próprio G1 deste work item. Nada foi alterado em US-01 a US-07 nem nos critérios delas.

## Contexto e problema

O pedido original foi: "Vamos utilizar o proprio sistema para apriomar seu corpo". O agent-team (v0.1.0) passou a ser usado para evoluir a si mesmo. No primeiro uso real (2026-09-16), o Orchestrator registrou 7 atritos (`.team/work/W-001-evolucao-v1-1/context.md`). A leitura do runtime mostrou outras lacunas de confiabilidade e de segurança.

O problema central é duplo:
1. **Atrito:** o fluxo trava ou incomoda em situações comuns: repositório sem commits, buscas no próprio código e bugfix com 4 aprovações.
2. **Confiança:** a garantia principal do produto ("o modelo não pula gates") tem brechas.
   - Reinstalar ou desinstalar o próprio guard não passa por gate.
   - A chave de assinatura pode ser lida por uma busca num diretório ancestral.
   - Uma reprovação feita depois de uma aprovação não anula essa aprovação.
   - O guard libera a ação quando tem um erro interno.
   - Uma decisão de gate incompleta (`APROVAR` sem o gate) não é registrada **e não gera retorno nenhum**, então o usuário acredita ter aprovado e o fluxo fica parado sem explicação. Isso aconteceu no G1 deste work item (B-18).

O resultado esperado da v1.1 é um incremento pequeno que remove os atritos que bloqueiam o fluxo e fecha essas brechas, sem funcionalidades novas (agentes, métricas, vários work items).

## Personas
- **PO/Tech Lead (usuário):** aprova os gates, edita a config, instala o runtime no próprio terminal. Quer poucas aprovações sem valor e confiança de que nada relevante passa sem ele.
- **Orchestrator (sessão principal):** coordena o fluxo via CLI `team`. Precisa de mensagens de bloqueio que digam o que fazer.
- **Agentes especialistas (subagentes):** leem, buscam e alteram código dentro do escopo. Precisam pesquisar o próprio código sem falso positivo.

## Backlog priorizado

Esforço relativo: P = pequeno, M = médio, G = grande. Iteração: **R** = REQUIRED v1.1, **N** = NICE_TO_HAVE v1.1, **O** = OUT_OF_SCOPE (v1.2+).

| # | Item | Problema observado (evidência) | Impacto | Esforço | MoSCoW | Iteração |
|---|---|---|---|---|---|---|
| B-01 | Bootstrap de repositório sem commits | Atrito 1 (a `main` não tem commits; o agente não cria o commit base). `SKILL.md` §14 supõe uma principal com commits. Pela leitura de `guard-rules.mjs:95-105`, `currentBranch` devolve `null` quando `git rev-parse` falha (branch sem commits), e aí `detectMerge` não reconhece a principal (`:67`). Isso seria *fail-open* e **diverge do relato**; precisa ser confirmado por teste. | O fluxo para antes de IMPLEMENTING em todo projeto novo, ou o guard deixa passar commit na principal | P | MUST | R (US-01) |
| B-02 | Instalar ou desinstalar o agent-team não conta como deploy | Atrito 2. `DEFAULT_DEPLOY_PATTERNS` (`core.mjs:113-132`) não cobre `install:claude`, `uninstall:claude` nem `scripts/(un)install.mjs` (`package.json:13-14`). O instalador reescreve o runtime e o `settings.json`, e o desinstalador remove os hooks (`uninstall.mjs:26-35`), sem citar os caminhos que o guard vigia (`guard-rules.mjs:38-39,51,58`). | **Maior brecha do dogfooding:** um agente pode trocar ou remover o próprio guard no meio do fluxo, sem G4 | P | MUST | R (US-02) |
| B-03 | Falsos positivos em buscas | Atrito 3. Em `guard-rules.mjs:137-139`, Grep e Glob são avaliados pelo **texto do padrão**, e `approval.key` ou `.claude/team` no padrão bloqueiam a busca. O shell tem regra equivalente (`:50-55`). Esses literais existem no próprio código (`core.mjs:11`, `guard-rules.mjs`, README, SKILL.md, testes). | Os agentes não pesquisam o próprio código; leem arquivos inteiros (mais tokens) ou tentam contornar | P–M | MUST | R (US-03) |
| B-04 | A chave pode ser lida por busca num diretório ancestral | Em `guard-rules.mjs:136-140`, só a menção literal é verificada. Um Grep com alvo em `~/.claude` (ou `~`) e padrão que case com hexadecimal devolveria o conteúdo de `approval.key`. | Quem tem a chave consegue forjar aprovação, a garantia central do produto | P | MUST | R (US-03) |
| B-05 | A última decisão do usuário não prevalece | A reprovação grava `Gx.rejected.json` e mantém `Gx.json` (`core.mjs:311-314`). `checkApproval` ignora reprovações (`:320-349`). O teste `core.test.mjs:41-48` só cobre reprovação sem aprovação anterior. | O usuário manda `REPROVAR` depois de `APROVAR`, antes do `team move`, e o fluxo ainda avança | P | MUST | R (US-04) |
| B-06 | O guard libera a ação quando falha | `guard.mjs:16-22` devolve exit 0 em qualquer exceção, inclusive em projeto com time ativo. Uma branch indeterminada conta como "não principal". | Um bug nas regras (provável neste ciclo, que altera essas regras) desliga a proteção sem aviso | P | SHOULD | R (US-05) |
| B-07 | Formato do hook UserPromptSubmit não validado no harness real | Atrito 4. `prompt-approval.mjs:16-20` só foi testado em processo isolado (`hooks.test.mjs`). A documentação oficial aceita `hookSpecificOutput.additionalContext` e também stdout em texto puro. **Validado no harness real em 2026-09-17** (`results/RNF-06a-harness.md`): o formato funciona; o mesmo teste revelou o B-18. | Se o harness ignorasse a saída, o Orchestrator não ficaria sabendo da aprovação. O fluxo continua seguro, porque o `team move` valida, mas a experiência quebraria | P | MUST | R (RNF-06, checagem: (a) feita, (b) no deploy) |
| B-18 | Decisão de gate incompleta não dá retorno | Achado no G1 deste work item, em 2026-09-17 (`.team/work/W-001-evolucao-v1-1/results/RNF-06a-harness.md`, `followups.md`). O usuário enviou `APROVAR` sem o gate; as regex de `prompt-approval.mjs:13-14` exigem `g1..g4|prod`, e `main()` sai sem emitir nada quando não casa (`:33`). Nada foi registrado e **nenhum aviso** chegou à sessão. Na tentativa seguinte, `APROVAR G1` funcionou. | O usuário pensa que aprovou; o fluxo fica parado sem explicação, e o Orchestrator só descobre conferindo o `team status`. Falha segura (nada foi aprovado por engano), mas sem retorno | P | MUST | R (US-08) |
| B-08 | Config padrão pede 4 aprovações num bugfix | Atrito 7. `defaultConfig` (`core.mjs:140-147`) liga todos os gates em todas as trilhas. O README (`:119`) mostra o ajuste manual. | Atrito em tarefas pequenas e incentivo a fugir do fluxo | P | SHOULD | N (US-06) |
| B-09 | Motivos e títulos com `; & \| > <` são recusados | `SHELL_META_RE` (`guard-rules.mjs:25`) avalia o comando inteiro, inclusive o texto entre aspas. `SKILL.md:45` manda evitar esses caracteres. O título salvo em `state.json` está sem acento ("Evolucao") e o do plano, com acento. | Motivos de auditoria mais pobres e tentativas repetidas | M | COULD | N (US-07) |
| B-10 | Invocação longa do CLI | Atrito 5. `SKILL.md:44`; o guard só reconhece a forma `node ".../.claude/team/bin/team.mjs"` (`guard-rules.mjs:23-24`). | Comandos verbosos e sujeitos a erro | M | COULD | O |
| B-11 | A aprovação não está ligada ao conteúdo aprovado | README "Limites" (`:147`). Os campos assinados não incluem os artefatos (`core.mjs:275-277`). | Um documento alterado depois do gate passa despercebido | G | SHOULD | O (1º candidato à v1.2) |
| B-12 | O runtime em desenvolvimento opera o `.team/` real com a chave real | Neste repositório, `node runtime/bin/team.mjs ...` ou um script que importe `runtime/lib/core.mjs` não é reconhecido pelo guard (`guard-rules.mjs:23-28,48-60`). Esse código usa o `TEAM_HOME` padrão (`core.mjs:10-11`), e `recordDecision` é exportada (`:291`). | Durante o dogfooding, código ainda não revisado ou um script de checagem pode mudar o estado real ou assinar uma decisão | M (mitigar) / G (resolver) | SHOULD | N (mitigação) / O (solução estrutural) |
| B-13 | Um único work item ativo por projeto | Atrito 6 (`core.mjs:462-464`) | Não dá para fazer um hotfix com um épico em andamento | G | COULD | O |
| B-14 | Guard ciente do agente (escrita por papel) | README "Evolução (v2)". A entrada do PreToolUse traz `agent_type` quando roda num subagente (doc oficial dos hooks), então a ideia é viável. | Um papel pode escrever fora do próprio domínio | M–G | COULD | O |
| B-15 | Ferramentas fora do matcher do guard | `PRE_TOOL_MATCHER` (`settings-hooks.mjs:5`) não cobre ferramentas MCP que escrevem arquivos | Escrita protegida feita por ferramenta não avaliada | M | COULD | O |
| B-16 | Métricas por work item | README "Evolução (v2)" | Pouca visibilidade de custo e retrabalho | M | COULD | O |
| B-17 | Novos agentes (database, security, mobile, data) | README "Evolução (v2)" | Especialidades a mais; não resolve atrito observado | G | WON'T (v1.1) | O |

## Histórias de usuário

Todas as histórias valem para projetos com time ativo (`.team/` presente e `enforce` diferente de `false`), salvo quando o critério disser outra coisa.

### US-01 — Bootstrap de repositório sem commits (REQUIRED)
Como PO/Tech Lead, quero que o fluxo reconheça um repositório sem commits e me diga exatamente o que fazer, para que o work item não trave antes de IMPLEMENTING e o guard não deixe passar commits na principal.

**Critérios de aceitação**
- CA-01.1 Dado um repositório git sem commits, na branch principal ainda sem commits (por exemplo, `main`), quando um agente executa `git commit`, então a ação é bloqueada, e a mensagem diz que o commit base deve ser criado pelo usuário no próprio terminal.
- CA-01.2 Dado um repositório git em que a branch atual não pode ser determinada, quando um agente executa um comando que altera histórico (commit, merge, rebase, push, cherry-pick, revert, am), então a ação é bloqueada, e a mensagem informa que a branch não foi identificada.
- CA-01.3 Dado um repositório git sem commits, quando o Orchestrator executa `team status` (texto e `--json`), então a saída avisa que falta o commit base na principal e que o usuário precisa criá-lo antes de IMPLEMENTING.
- CA-01.4 Dado um repositório git sem commits, quando o Orchestrator executa `team init`, então a saída traz o mesmo aviso.
- CA-01.5 Dado um repositório com commit base, na branch do work item, quando um agente executa `git commit`, então a ação é permitida (regressão).
- CA-01.6 Dado um diretório com `.team/` mas sem git, quando se executa `team status` ou `team init`, então nenhum aviso de git aparece e o comando não falha.
- CA-01.7 Dado um repositório com commits e HEAD destacado (*detached*), quando um agente executa `git commit`, então o comportamento é o mesmo da v1.0 (permitido). PREMISSA.

### US-02 — Instalar ou desinstalar o agent-team é deploy (REQUIRED)
Como PO/Tech Lead, quero que reinstalar ou desinstalar o agent-team a partir de uma sessão de agente passe pelos meus gates de deploy, para que nenhum agente troque ou remova o guard que me protege no meio de um fluxo.

**Critérios de aceitação**
- CA-02.1 Dado um projeto com time ativo, fora de `DEPLOYING` ou `DEPLOYING_PROD`, quando um agente executa `npm run install:claude`, `npm run uninstall:claude`, `node scripts/install.mjs` ou `node scripts/uninstall.mjs` (com barra ou contrabarra no caminho), então a ação é bloqueada, e a mensagem cita o gate exigido.
- CA-02.2 Dado o estado `DEPLOYING` com G4 válido, quando um agente executa o instalador com um diretório de destino alternativo (`--claude-dir <dir>`), então a ação é permitida.
- CA-02.3 Dado o estado `DEPLOYING` com G4 válido, quando um agente executa o instalador ou o desinstalador contra o diretório real do usuário (sem `--claude-dir`), então a ação é bloqueada, a menos que o estado seja `DEPLOYING_PROD` com PROD válido. Este critério depende da pergunta Q-03.
- CA-02.4 Dado um projeto com time ativo em qualquer fase, quando um agente executa `npm test`, então a ação é permitida. Os testes de instalação continuam rodando em diretório temporário (regressão).
- CA-02.5 Dado um diretório sem `.team/`, quando se executa o instalador, então nada é bloqueado (regressão: o usuário instala no próprio terminal).
- CA-02.6 Dado um projeto recém-inicializado com `team init`, então a proteção dos critérios CA-02.1 a CA-02.3 já vale, sem edição manual da config.

### US-03 — Buscas sem falso positivo e sem vazar a chave (REQUIRED)
Como agente especialista, quero pesquisar o código do projeto por qualquer texto, inclusive os nomes de arquivos protegidos, para entender o sistema sem ser bloqueado. E, como PO/Tech Lead, quero que nenhuma busca exponha a chave de assinatura.

**Critérios de aceitação**
- CA-03.1 Dado um projeto com time ativo, quando um agente usa Grep com alvo dentro do projeto e um padrão de texto que contém `.claude/team`, `.team/state.json`, `.team/config.json` ou `approval.key`, então a busca é permitida.
- CA-03.2 Dado o mesmo projeto, quando um agente usa Glob com um padrão que contém esses literais, então a busca é permitida.
- CA-03.3 Dado um projeto com time ativo, quando um agente usa Grep cujo alvo é o arquivo da chave, o diretório do runtime instalado, um subdiretório dele ou **qualquer diretório ancestral da chave** (por exemplo `~/.claude` ou `~`), então a busca é bloqueada, e a mensagem cita a proteção da chave.
- CA-03.4 Dado um projeto com time ativo, quando um agente usa Read no arquivo da chave, então a leitura continua bloqueada. Read em outros arquivos do runtime instalado ou em `.team/state.json` continua permitido (regressão).
- CA-03.5 Dado um projeto com time ativo, quando um comando de shell cita esses literais e é bloqueado, então a mensagem indica a alternativa (ferramenta de busca nativa Grep/Glob, ou Read para leitura). PREMISSA: o bloqueio em shell continua conservador nesta versão (ver Q-05).
- CA-03.6 Todos os bloqueios de shell de `guard.test.mjs` continuam valendo (regressão).

### US-04 — A última decisão do usuário sobre um gate prevalece (REQUIRED)
Como PO/Tech Lead, quero que a minha decisão mais recente sobre um gate seja a que vale, para poder voltar atrás numa aprovação antes de o fluxo avançar.

**Critérios de aceitação**
- CA-04.1 Dado o estado `WAITING_G1_APPROVAL` com G1 aprovado, quando o usuário envia `REPROVAR G1 <motivo>`, então a aprovação anterior deixa de valer, e `team move ARCHITECTING` é recusado com o código de bloqueio por aprovação (hoje, 3).
- CA-04.2 Dado o estado `WAITING_G1_APPROVAL` com G1 reprovado, quando o usuário envia `APROVAR G1`, então a aprovação vale e `team move ARCHITECTING` é aceito. PREMISSA: a última decisão vale nos dois sentidos.
- CA-04.3 Dado qualquer sequência de decisões sobre o mesmo gate, então o log de auditoria guarda todas elas, em ordem, com `actor: user`; nenhuma é apagada.
- CA-04.4 Dado o cenário de CA-04.1, quando o Orchestrator executa `team status --json`, então o gate aparece como não aprovado.
- CA-04.5 Dado o cenário de CA-04.1 e uma sessão de agente, quando o agente tenta um merge (G3) ou um deploy (G4) cujo gate foi reprovado por último, então o guard bloqueia.
- CA-04.6 Os testes de aprovação forjada, adulterada, revogada e fora de estado continuam passando (regressão).

### US-05 — O guard bloqueia quando falha, dentro de projetos com time ativo (REQUIRED)
Como PO/Tech Lead, quero que um erro interno do guard bloqueie a ação em projetos com time ativo, para que um bug nas regras não desligue a proteção sem aviso.

**Critérios de aceitação**
- CA-05.1 Dado um projeto com time ativo (`enforce` diferente de `false`), quando a avaliação do guard lança um erro inesperado, então a ação é bloqueada (exit 2), com a mensagem `[agent-team] BLOQUEADO:` que identifica um erro interno do guard e orienta a reportar ao usuário.
- CA-05.2 Dado um diretório sem `.team/`, quando a avaliação lança um erro, então a ação é permitida, e o erro é registrado em stderr (regressão: não travar outras sessões).
- CA-05.3 Dada uma entrada que não é JSON, então a ação é permitida (regressão com `hooks.test.mjs`, porque sem entrada legível não dá para saber se há time ativo). PREMISSA.
- CA-05.4 Dado um projeto com `enforce: false`, quando a avaliação lança um erro, então a ação é permitida.

### US-06 — Trilha P mais leve na config padrão (NICE_TO_HAVE, depende de Q-04)
Como PO/Tech Lead, quero que um projeto novo já venha com menos aprovações na trilha P, para não aprovar requisitos e arquitetura de um bugfix.

**Critérios de aceitação**
- CA-06.1 Dado um projeto novo, quando o Orchestrator executa `team init`, então a trilha P da config fica com G1 e G2 desligados e G3 e G4 ligados, e as trilhas M e G ficam com todos os gates ligados.
- CA-06.2 Dado um projeto já inicializado, quando o runtime v1.1 é instalado, então a config existente continua como está.
- CA-06.3 Dado `team init`, então a saída lista os gates ligados em cada trilha.
- CA-06.4 Dado um work item da trilha P em `WAITING_PROD_APPROVAL`, então PROD continua exigindo aprovação (regressão).

### US-07 — Motivos e títulos com qualquer caractere (NICE_TO_HAVE)
Como Orchestrator, quero passar motivos e títulos com `; & | > <` e acentos numa chamada isolada do CLI, para registrar a auditoria sem reescrever o texto.

**Critérios de aceitação**
- CA-07.1 Dada uma chamada isolada do CLI com `--reason` ou `--title` entre aspas contendo `;`, `&`, `|`, `>` ou `<`, então o guard permite a chamada e o texto é gravado sem alteração.
- CA-07.2 Dado um título com acentos (por exemplo, "Evolução"), executado no PowerShell e no Git Bash, então o estado grava o texto com os acentos.
- CA-07.3 Todos os comandos compostos de `guard.test.mjs` (`&&`, `;`, `$( )`, redirecionamento fora das aspas) continuam bloqueados (regressão).

### US-08 — Retorno quando a decisão do gate vem incompleta (REQUIRED)
Como PO/Tech Lead, quero ser avisado quando a minha mensagem parecer uma decisão de gate mas não for reconhecida, para não achar que aprovei algo que continua parado.

Regra que separa decisão de conversa: só há aviso quando a **primeira linha** da mensagem é composta apenas por um verbo de decisão (`APROVAR`, `APROVO`, `APROVADO`, `REPROVAR`, `REPROVO`, `REJEITAR`, `REJEITO`) e, opcionalmente, um único token curto de gate, com ou sem pontuação final. Qualquer outra palavra na linha significa conversa, e o hook continua silencioso.

**Critérios de aceitação**
- CA-08.1 Dado um work item em `WAITING_G1_APPROVAL`, quando o usuário envia uma mensagem cuja primeira linha é só `APROVAR` (idem para `APROVO` e `APROVADO`, em qualquer caixa), então nenhuma aprovação é registrada, e a sessão recebe um aviso que diz que nada foi registrado, nomeia o gate aguardando (G1) e mostra o comando exato a digitar (`APROVAR G1`).
- CA-08.2 Dado o mesmo estado, quando a primeira linha é `APROVAR G9`, `APROVAR GX` ou `APROVAR G0`, então o comportamento é o do CA-08.1 (nada registrado e aviso com o comando exato).
- CA-08.3 Dado o mesmo estado, quando a primeira linha é só `REPROVAR` (idem `REPROVO`, `REJEITAR`, `REJEITO`) ou `REPROVAR G9`, então nada é registrado, e o aviso mostra o comando exato com o motivo (`REPROVAR G1 <motivo>`).
- CA-08.4 Dado um work item ativo em fase que não aguarda decisão (por exemplo `PLANNING`), quando a primeira linha é só `APROVAR`, então nada é registrado, e o aviso informa que nenhum gate está aguardando decisão e qual é o estado atual.
- CA-08.5 Dado um diretório sem `.team/`, ou um projeto com time mas sem work item ativo, quando a primeira linha é só `APROVAR`, então nada é registrado e nada é emitido para a sessão (stdout vazio).
- CA-08.6 Dado um work item em `WAITING_G1_APPROVAL`, quando o usuário envia "precisamos aprovar isso amanhã", "o cliente aprovou o orçamento", "vamos revisar antes de aprovar", "acho que dá pra APROVAR G1" ou "ok, pode seguir", então nada é registrado e nada é emitido para a sessão (stdout vazio), em cada uma das mensagens.
- CA-08.7 Dado qualquer cenário desta história, então nenhum arquivo é criado em `.team/approvals/<work>/` e nenhum evento de decisão entra no log de auditoria.
- CA-08.8 Regressão com `hooks.test.mjs`: `APROVAR G1` no estado esperado registra a aprovação e devolve o aviso de sucesso; observações nas linhas seguintes continuam acompanhando a decisão; `REPROVAR G1: <motivo>` continua registrando o motivo; `APROVAR G2` fora do estado esperado continua sem registro e com o aviso de que nada foi registrado.
- CA-08.9 Todo aviso desta história está em português, começa com o prefixo `[agent-team]`, deixa explícito que **nada foi aprovado ou reprovado** e diz qual é o próximo passo do usuário. Não é uma mensagem de bloqueio, então não usa o prefixo `BLOQUEADO`.

## Requisitos funcionais
| ID | Descrição | Prioridade (MoSCoW) | Histórias |
|---|---|---|---|
| RF-01 | O guard trata uma branch principal sem commits como principal, e uma branch indeterminada como possível principal, em comandos que alteram histórico | Must | US-01 |
| RF-02 | `team init` e `team status` avisam quando falta o commit base e dizem que o usuário deve criá-lo | Must | US-01 |
| RF-03 | A instalação e a desinstalação do agent-team, a partir de uma sessão de agente, seguem as regras de deploy (G4) e de produção (PROD) | Must | US-02 |
| RF-04 | A proteção do RF-03 vale por padrão em projetos novos, sem edição manual | Must | US-02 |
| RF-05 | Buscas com Grep e Glob são avaliadas pelo alvo, não pelo texto do padrão | Must | US-03 |
| RF-06 | Um Grep cujo alvo contenha a chave de assinatura (arquivo, runtime ou diretório ancestral) é bloqueado | Must | US-03 |
| RF-07 | Bloqueios de shell por literais protegidos indicam a ferramenta alternativa | Should | US-03 |
| RF-08 | A decisão mais recente do usuário sobre um gate determina se ele está aprovado, no CLI e no guard | Must | US-04 |
| RF-09 | O histórico de decisões é preservado no log de auditoria | Must | US-04 |
| RF-10 | Um erro interno do guard bloqueia a ação em projeto com time ativo e libera fora dele | Should | US-05 |
| RF-11 | A config padrão desliga G1 e G2 na trilha P | Could | US-06 |
| RF-12 | O CLI aceita motivos e títulos com metacaracteres entre aspas e com acentos | Could | US-07 |
| RF-13 | Uma mensagem do usuário com intenção de decisão de gate, mas sem gate válido, não registra nada e devolve à sessão um aviso com o gate que está aguardando (ou a ausência dele) e o comando exato a digitar | Must | US-08 |
| RF-14 | O aviso do RF-13 só é emitido quando a primeira linha da mensagem contém apenas o verbo de decisão e, no máximo, um token de gate; mensagens de conversa continuam sem aviso e sem registro | Must | US-08 |

## Requisitos não funcionais
| ID | Categoria | Requisito mensurável |
|---|---|---|
| RNF-01 | Compatibilidade | Node ≥ 20.11, sem dependências externas. `npm test` passa no Windows (PowerShell e Git Bash) com Node 24. |
| RNF-02 | Testabilidade | Cada CA de história REQUIRED tem ao menos 1 teste `node:test`. Os 29 testes existentes continuam passando; se algum mudar, a mudança é justificada por um CA desta versão no resultado do QA. |
| RNF-03 | Desempenho | Hook `guard.mjs`: p95 ≤ 500 ms em 50 execuções seguidas, numa máquina de desenvolvimento local, com comando git. PREMISSA: não há baseline medido. O QA mede a v1.0 e a v1.1 e informa as duas. |
| RNF-04 | Segurança | Em caso de dúvida dentro de projeto com time ativo, o guard bloqueia; fora dele, nunca bloqueia. Nenhuma mensagem, log ou teste exibe o conteúdo da chave. |
| RNF-05 | Usabilidade | Toda mensagem de bloqueio nova ou alterada começa com `[agent-team] BLOQUEADO:`, está em português e informa o motivo e o próximo passo (quem age e o quê). Os testes verificam o prefixo e a presença do próximo passo. |
| RNF-06 | Compatibilidade com o harness | Evidência registrada em `.team/work/W-001-evolucao-v1-1/results/` de dois momentos: (a) **atendido em 2026-09-17** — `APROVAR G1` numa sessão real devolveu o aviso via `hookSpecificOutput.additionalContext` (`results/RNF-06a-harness.md`); o mesmo teste revelou o B-18, que virou a US-08; (b) pendente — no smoke do deploy, `APROVAR Gx`, uma decisão incompleta (US-08) e um comando bloqueado funcionam numa sessão real com o runtime v1.1. |
| RNF-07 | Migração | O runtime v1.1 lê sem erro o estado, a config e as aprovações assinadas da v1.0. O W-001, ainda em andamento, continua operável depois da reinstalação: aprovações já dadas continuam válidas e os gates seguintes continuam funcionando. Um teste com dados no formato v1.0 comprova isso. |
| RNF-08 | Auditoria | Todo bloqueio por erro interno (US-05) e toda decisão do usuário (US-04) ficam rastreáveis: a decisão, no log; o erro interno, em stderr. |
| RNF-09 | Documentação | O README (seções "O que o runtime garante", "Limites", config e fluxo de bootstrap) e um CHANGELOG com a entrada 1.1.0 são atualizados no mesmo merge. |
| RNF-10 | Idioma | Mensagens, prompts e docs em português; identificadores de código em inglês. |

## Escopo
### REQUIRED
- US-01, US-02, US-03, US-04, US-05 (B-01 a B-06).
- US-08 (B-18), incorporada na versão 2 com autorização do usuário no G1.
- Checagem RNF-06 (B-07) e migração RNF-07.
- Documentação (RNF-09), incluindo em "Limites" o risco B-12 e a regra de dogfooding: o código do runtime em desenvolvimento só é exercitado com `AGENT_TEAM_HOME` temporário e projeto temporário, como já fazem os testes.

### NICE_TO_HAVE
- US-06: trilha P mais leve. A condição foi satisfeita (Q-04 aceita no G1); continua NICE_TO_HAVE, entra se couber no ciclo.
- US-07: motivos e títulos com qualquer caractere.
- B-12 (mitigação): padrão na config deste repositório para bloquear a execução direta de `runtime/bin/team.mjs` e `runtime/hooks/*.mjs` fora dos testes (ver Q-06).

### OUT_OF_SCOPE
- B-11: aprovação ligada ao hash dos artefatos. É G e muda o formato das aprovações; fica como 1º candidato da v1.2.
- B-10: CLI curto. Exige mudar o reconhecimento de chamadas no guard; o ganho é de conforto.
- B-13: vários work items. Muda a estrutura do estado e do guard (G).
- B-14: guard ciente do agente. É viável (`agent_type`), mas é funcionalidade nova (M–G).
- B-15: ferramentas MCP no guard. Está fora do atrito observado.
- B-16: métricas. B-17: novos agentes. São funcionalidades novas; a v1.1 prioriza atrito e segurança.
- B-12 (solução estrutural): chave fora do alcance do processo do agente. G, fica para v2.

## Glossário
- **Work item:** unidade de trabalho do time (`W-NNN-slug`), com trilha, branch e estado.
- **Gate:** ponto de aprovação humana (G1 requisitos, G2 arquitetura, G3 merge, G4 deploy, PROD produção).
- **Trilha:** P (bug ou ajuste), M (feature), G (sistema, épico ou mudança estrutural).
- **Guard:** hook PreToolUse que bloqueia ações fora da fase.
- **Harness:** o Claude Code real executando os hooks, em oposição ao teste em processo isolado.
- **Commit base:** primeiro commit da branch principal, do qual sai a branch do work item.
- **Branch sem commits (unborn):** branch apontada por HEAD que ainda não tem nenhum commit.
- **Fail-open / fail-closed:** em caso de erro, liberar / bloquear a ação.
- **Runtime instalado:** cópia do CLI, dos hooks e da lib no diretório do Claude do usuário, junto com a chave de assinatura.
- **Deploy (deste projeto):** reinstalar ou desinstalar o agent-team no diretório real do usuário.
- **Dogfooding:** usar o próprio agent-team para desenvolver o agent-team.
- **Revogação:** perda de validade de aprovações posteriores ao destino de um retrabalho.

## Premissas
- As premissas ligadas a Q-01, Q-02 e Q-03 deixaram de ser premissas: foram confirmadas pelo usuário na aprovação do G1 (ver "Decisões do G1").
- PREMISSA (US-08): o aviso de decisão incompleta só vale quando a primeira linha da mensagem tem apenas o verbo de decisão e, no máximo, um token de gate. É o que separa a decisão da conversa e mantém a regressão de `hooks.test.mjs`.
- PREMISSA: o commit base é criado pelo usuário no terminal dele (Q-01). US-01 foi escrita assim.
- PREMISSA: a última decisão vale nos dois sentidos, reprovar depois de aprovar e aprovar depois de reprovar (CA-04.2).
- PREMISSA: HEAD destacado mantém o comportamento da v1.0 (CA-01.7).
- PREMISSA: entrada ilegível no guard continua liberada (CA-05.3).
- PREMISSA: o bloqueio de shell por literais protegidos continua conservador (CA-03.5).
- PREMISSA: não há baseline de desempenho do guard; o RNF-03 usa um limite absoluto.
- PREMISSA: `--dry-run` do instalador também é bloqueado fora de DEPLOYING. É um falso positivo aceitável, porque há o teste automatizado como alternativa.
- PREMISSA: a proteção deste ciclo vem só da config (Q-02), porque o código da v1.1 só vale depois de instalado, em DEPLOYING.

## Decisões do G1 (2026-09-17)
- O usuário aprovou o G1 e **aceitou as recomendações Q-01 a Q-06** exatamente como estão nas tabelas abaixo. Elas deixam de ser UNKNOWN e passam a valer como decisão:
  - Q-01: o commit base em `main` é criado pelo usuário, no terminal dele, sem `docs/`.
  - Q-02: os padrões do instalador e do desinstalador entram em `deploy.patterns`.
  - Q-03: instalar no diretório real conta como produção (PROD); com `--claude-dir`, conta como deploy não produtivo (G4). Confirma o CA-02.3.
  - Q-04: a config padrão desliga G1 e G2 na trilha P (US-06 sai de NICE_TO_HAVE condicional e pode ser implementada).
  - Q-05: o bloqueio de buscas via shell continua conservador nesta versão.
  - Q-06: a execução direta de `runtime/bin/team.mjs` e `runtime/hooks/*.mjs` é bloqueada pela config deste repositório.
- Autorizou também a inclusão do B-18 (US-08) no escopo REQUIRED.
- Continuam abertas apenas Q-07 (Orchestrator) e Q-08 (QA), que são checagens técnicas e não afetam o escopo aprovado.

## Perguntas em aberto (UNKNOWN)

**Aceitas na aprovação do G1 (mantidas aqui como registro da recomendação e do motivo)**

| # | Pergunta | Recomendação | Impacto se errado |
|---|---|---|---|
| Q-01 | Quem cria o commit base em `main`? (UNKNOWN 2 do plano) | **Você, no seu terminal, antes de IMPLEMENTING.** O terminal não passa pelos hooks e isso mantém a regra "agentes não commitam na principal". Inclua o estado atual (`.gitignore`, `README.md`, `package.json`, `runtime/`, `scripts/`, `src/`, `tests/`) e **não inclua `docs/`**: o documento de requisitos pertence à branch do work item. Depois, o Orchestrator cria `team/w-001-evolucao-v1-1` a partir desse commit. Não desligue `enforce` para isso. | Sem commit base, a branch do work item não tem de onde sair. Um commit feito pelo agente abriria exceção à regra central. |
| Q-02 | Adicionar ao `deploy.patterns` de `.team/config.json` um padrão para o instalador e o desinstalador? (UNKNOWN 3 do plano) | **Sim, antes de IMPLEMENTING.** O guard instalado é o da v1.0, então só a config protege este ciclo. Sugestão, a ser validada pelo devops/QA: em `deploy.patterns`, `"\\b(un)?install:claude\\b"` e `"\\bnode(\\.exe)?\\s+\\S*scripts/(un)?install\\.mjs"`. Inclua o desinstalador, porque ele remove os hooks. O segundo padrão só casa quando o script é executado via `node`, para não bloquear `git add` ou `git diff` desses arquivos. O guard troca `\` por `/` antes de testar, então os padrões valem para os dois separadores. Efeitos colaterais: `--dry-run` também fica bloqueado, e um caminho com espaços escapa do segundo padrão. `npm test` não é afetado. | Um agente pode reinstalar ou remover o guard no meio do fluxo, sem G4 (B-02). |
| Q-03 | Reinstalar no diretório real do usuário conta como **produção** (exige `APROVAR PROD`), e instalar em diretório temporário (`--claude-dir`) conta como deploy não produtivo (G4)? | **Sim.** A instalação real altera o guard de todas as sessões; a instalação temporária serve de smoke. Se aceitar, acrescente em `production_patterns`: `"^(?!.*--claude-dir).*(\\b(un)?install:claude\\b\|\\bnode(\\.exe)?\\s+\\S*scripts/(un)?install\\.mjs)"` (sugestão, a validar; na config, escreva `|` no lugar de `\|`, que aqui só escapa a tabela). Isso define o CA-02.3. | Se a resposta for "não", a instalação real passa só com G4 e o CA-02.3 muda. |

**Q-04 a Q-06: aceitas no G1. Q-07 e Q-08: seguem abertas, sem impacto no escopo**

| # | Pergunta | Recomendação | Impacto se errado |
|---|---|---|---|
| Q-04 | A config padrão de projetos novos deve desligar G1 e G2 na trilha P (US-06)? | **Sim, como NICE_TO_HAVE.** G3 (merge) e G4/PROD (deploy) continuam protegendo. Risco: o Orchestrator escolher P para pular gates, mitigado pela regra "na dúvida, trilha maior" e pelo G3, em que você vê o diff. | Se o padrão ficar rígido, o atrito continua; se ficar leve demais, aumenta o risco de classificar errado. |
| Q-05 | Liberar também buscas via shell (grep, rg, Select-String) que só citam os literais protegidos? | **Não nesta versão.** Grep/Glob nativos resolvem o atrito, e distinguir leitura de escrita no shell por regex é frágil. | Liberar cedo demais pode abrir brecha; manter causa atrito residual pequeno. |
| Q-06 | Bloquear, na config deste repositório, a execução direta de `runtime/bin/team.mjs` e `runtime/hooks/*.mjs` (B-12)? | **Sim**, com um padrão como `"\\bnode(\\.exe)?\\s+\\S*runtime/(bin/team\|hooks/[\\w-]+)\\.mjs"` em `deploy.patterns` (na config, escreva `|` no lugar de `\|`). Os testes rodam via `npm test` e não são afetados, e `git add`/`git diff` desses arquivos continuam livres. `node -e` importando a lib não é coberto (limite conhecido). | Sem isso, código ainda não revisado pode mudar o estado real ou assinar uma decisão. |
| Q-07 | (Para o Orchestrator) O título sem acento em `state.json` ("Evolucao") foi um contorno de encoding no shell? | Confirmar. Se foi, o CA-07.2 sobe de prioridade. | Acentos corrompidos na auditoria. |
| Q-08 | (Para o QA) `git commit` numa `main` sem commits foi de fato bloqueado (relato do atrito 1) ou foi liberado (leitura de `guard-rules.mjs:95-105`)? | Confirmar com um teste antes de implementar a US-01. | Diagnóstico errado de B-01. |
