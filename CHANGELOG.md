# Changelog

Todas as mudanças relevantes deste projeto ficam registradas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/), e o projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [1.1.0] - 2026-09-19

Work item `W-001-evolucao-v1-1`, o primeiro feito com o próprio agent-team. Requisitos em [`docs/requirements/W-001-evolucao-v1-1.md`](docs/requirements/W-001-evolucao-v1-1.md) e decisões nos ADRs 001 a 010 de [`docs/architecture/`](docs/architecture/).

A US-07 (títulos e motivos com metacaracteres entre aspas) foi adiada para a 1.2.0 por um problema de segurança encontrado na revisão. A chamada do CLI `team` continua recusando esses caracteres em qualquer lugar do comando, como na 1.0.0.

### Atualização a partir da 1.0.0 (leia antes de instalar)

- **Projetos que já têm `.team/` não recebem as proteções novas da config sozinhos.** A config do projeto substitui os padrões do código, então a proteção contra instalar ou remover o agent-team (US-02) e a trilha P mais leve (US-06) só valem em projetos criados com `team init` na 1.1.0. Nos projetos existentes, acrescente os padrões ao `.team/config.json`, no seu editor, conforme o README ([Projetos que já têm `.team/`](README.md#projetos-que-já-têm-team-atualização-da-v10)).
- O estado, a config, as aprovações assinadas e o log da 1.0.0 continuam válidos. Nada é migrado nem reescrito, e voltar para a 1.0.0 não exige conversão ([ADR-007](docs/architecture/adr-007-compatibilidade-e-migracao-v1-0-para-v1-1.md)).
- O guard agora bloqueia quando tem um erro interno (US-05). Se isso travar um projeto, a saída é você colocar `"enforce": false` no `.team/config.json` desse projeto.

### Added

- **US-01 — Bootstrap de repositório sem commits.** `team init` e `team status` avisam quando a branch principal ainda não tem o commit base e dizem que ele é criado por você, no seu terminal. O `team status --json` ganhou a chave `git` (`repo`, `branch`, `branch_kind`, `has_base_commit`, `warnings`). Fora de um repositório git, nada muda.
- **US-02 — Instalar e desinstalar o agent-team é deploy.** Em projetos novos, `npm run install:claude`, `npm run uninstall:claude` e `node .../scripts/(un)install.mjs` executados por um agente exigem `DEPLOYING` com G4 quando usam `--claude-dir`, e `DEPLOYING_PROD` com `APROVAR PROD` quando atingem o seu diretório real. No seu terminal, nada muda.
- **US-08 — Aviso quando a decisão do gate vem incompleta.** `APROVAR`, `APROVADO` ou `REPROVAR` sem gate, ou com um gate inválido como `APROVAR G9`, não registram nada e agora devolvem à sessão um aviso com o gate que está aguardando e o comando exato a digitar. Antes, a mensagem era ignorada em silêncio.
- `team init` lista os gates ligados em cada trilha.

### Changed

- **US-03 — Buscas avaliadas pelo alvo.** Grep e Glob no projeto podem procurar qualquer texto, inclusive `approval.key`, `.claude/team` e `.team/state.json`, que antes bloqueavam a busca. Em compensação, uma busca cujo alvo alcance a chave de assinatura (o arquivo, o runtime instalado ou um diretório acima, como `~/.claude` e `~`) passa a ser bloqueada. No shell, citar esses nomes continua bloqueado, e a mensagem agora indica usar Grep, Glob ou Read.
- **US-05 — O guard bloqueia quando falha.** Num projeto com time ativo, um erro interno do guard bloqueia a ação com `[agent-team] BLOQUEADO: erro interno do guard ...`, em vez de liberá-la sem aviso. Fora de projetos com time, ou com `enforce: false`, o comportamento é o da 1.0.0.
- **US-06 — Trilha P mais leve.** Projetos novos nascem com G1 e G2 desligados na trilha P. G3, G4 e PROD continuam valendo. As trilhas M e G não mudam.
- **Decisões de gate terminadas em `?` ou `;` são conversa.** `APROVAR G1?` e `APROVAR G1;` não registram nada e não geram aviso: só `. ! : ,` e `…` no fim da linha são aceitos. Por isso, `REPROVAR G1; motivo` deixou de registrar a reprovação, o que a 1.0.0 fazia. Use `REPROVAR G1: motivo`, `REPROVAR G1, motivo` ou `REPROVAR G1 motivo`.
- As mensagens de bloqueio novas (commit base, branch não identificada, busca e erro interno) dizem o que fazer a seguir.

### Fixed

- **A chamada do CLI `team` feita por um agente passou a recusar parênteses** (`(` e `)`), em qualquer shell e também entre aspas, por segurança. O efeito colateral é que títulos e motivos com parênteses precisam ser reescritos.

- **US-01 — Commit na principal sem commits.** O guard passou a reconhecer como principal uma branch que ainda não tem commits e bloqueia `git commit` de agente nela. Se a branch atual não puder ser identificada, comandos que alteram histórico são bloqueados. HEAD destacado continua como na 1.0.0.
- **US-04 — Vale a última decisão sobre o gate.** Uma `REPROVAR Gx` enviada depois de `APROVAR Gx` anula a aprovação, no CLI e no guard. Uma aprovação posterior volta a valer. Em empate de horário, vale a reprovação. O log de auditoria mantém todas as decisões.

## [1.0.0] - 2026-09-17

Publicada como `0.1.0` no `package.json` (commit `86c79f9`). Primeira versão do agent-team.

### Added

- Orchestrator como skill (`/orquestrar`) e agentes `product`, `architect`, `backend`, `frontend`, `qa-engineer`, `code-reviewer`, `devops` e `documentation`, montados em três camadas de prompt.
- CLI `team` com máquina de estados, trilhas P, M e G, DAG de tarefas e limite de retrabalho.
- Gates G1 a G4 e PROD com aprovação assinada (HMAC), registrada só pelo hook `UserPromptSubmit` a partir da mensagem do usuário.
- Guard `PreToolUse` contra edição de estado, config, aprovações e runtime, leitura da chave, merge fora de `MERGING` e deploy fora de `DEPLOYING`.
- Instalador e desinstalador para `~/.claude`, com backup do `settings.json`.
