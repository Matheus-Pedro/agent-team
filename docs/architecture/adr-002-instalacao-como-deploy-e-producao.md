# ADR-002 — Instalar e desinstalar o agent-team é deploy (e, no diretório real, produção)
Status: Aceito no G2 em 2026-09-17 · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

## Contexto
US-02, RF-03, RF-04, B-02, decisões Q-02 e Q-03 do G1. `DEFAULT_DEPLOY_PATTERNS` (`core.mjs:113-132`) cobre
docker, kubectl, terraform, vercel etc., mas não cobre `npm run install:claude`, `npm run uninstall:claude`,
`node scripts/install.mjs` nem `node scripts/uninstall.mjs`. O instalador reescreve `~/.claude/team/{bin,hooks,lib}`
e os hooks de `settings.json`; o desinstalador remove os hooks. Ou seja: **um agente pode trocar ou remover o
próprio guard no meio do fluxo, sem passar por gate nenhum** — a maior brecha encontrada no dogfooding.

O G1 já decidiu o "o quê": os padrões entram em `deploy.patterns`; instalar no diretório real do usuário conta
como **produção** (PROD) e instalar com `--claude-dir` conta como deploy não produtivo (G4). Falta decidir
**onde** os padrões vivem, para atender o RF-04 (valer em projeto novo sem edição manual).

## Opções consideradas
1. **Só na config deste repositório.** Prós: zero impacto em outros projetos. Contras: não atende o RF-04 nem
   o CA-02.6; qualquer `team init` novo nasce desprotegido; some se o `.team/` for recriado.
2. **Nos defaults do código (`core.mjs`), aplicados a todo projeto novo.** Prós: atende RF-04/CA-02.6; a
   proteção nasce com o projeto. Contras: os padrões são específicos do agent-team e passam a valer em
   qualquer projeto — um projeto alheio com `scripts/install.mjs` executado via `node` é classificado como
   deploy (falso positivo).
3. **Detectar o repositório agent-team no `team init`** (por `package.json` name) e injetar os padrões só ali.
   Prós: sem falso positivo em terceiros. Contras: mágica implícita, difícil de testar e de explicar;
   `team init` passa a depender do conteúdo do projeto.
4. **Reconhecer a instalação dentro do próprio instalador** (o script se recusa fora de DEPLOYING). Prós:
   protege também quando o comando não casa com padrão nenhum. Contras: o script roda em processo filho, fora
   do alcance do guard e sem acesso confiável ao `.team/` do projeto que originou a chamada; e um agente pode
   simplesmente copiar arquivos em vez de chamar o script.

## Decisão
Opção 2, com os padrões exatos validados no G1.

Em `DEFAULT_DEPLOY_PATTERNS`, acrescentar:

- `\b(un)?install:claude\b`
- `\bnode(\.exe)?\s+\S*scripts/(un)?install\.mjs`

Em `DEFAULT_PRODUCTION_PATTERNS`, acrescentar:

- `^(?!.*--claude-dir).*(\b(un)?install:claude\b|\bnode(\.exe)?\s+\S*scripts/(un)?install\.mjs)`

`detectDeploy` já converte `\` em `/` antes de testar e usa flag `i`, então os padrões valem para os dois
separadores e para qualquer caixa (CA-02.1). `production_patterns` só é consultado quando `patterns` casou,
então o lookahead negativo não afeta nenhum outro comando.

Semântica resultante:

| comando | classificação | exigência |
|---|---|---|
| `npm run install:claude` / `node scripts/install.mjs` | deploy **de produção** | `DEPLOYING_PROD` + `APROVAR PROD` (CA-02.3) |
| `npm run uninstall:claude` / `node scripts/uninstall.mjs` | deploy **de produção** | idem (o desinstalador remove os hooks) |
| `... install.mjs --claude-dir /tmp/x` | deploy não produtivo | `DEPLOYING`/`DEPLOYING_PROD` + G4 (CA-02.2) |
| `npm test` | não é deploy | livre (CA-02.4) — nenhum padrão casa; os testes de instalação rodam em processo filho, contra diretório temporário |
| qualquer um deles fora de projeto com `.team/` | não avaliado | livre (CA-02.5) |

**Documentação obrigatória** (RNF-09), porque a proteção não é retroativa: `loadConfig` faz
`deploy: { ...def.deploy, ...(cfg.deploy || {}) }`, e como `team init` **sempre grava** `deploy.patterns`, o
array do usuário substitui o default. Logo, **instalar a v1.1 não protege projetos já inicializados**. O
README e o CHANGELOG têm que trazer o trecho pronto para o usuário colar na config de projetos existentes
(ver ADR-010, que é exatamente esse trecho para este repositório).

## Consequências
- Positivas: fecha o B-02 em projetos novos; a instalação real do agent-team passa a exigir o gate mais forte
  que existe (PROD, não configurável); o desinstalador também é coberto.
- Negativas: falsos positivos em projetos de terceiros com `scripts/install.mjs` ou um script npm
  `*install:claude*`; `--dry-run` também fica bloqueado fora de DEPLOYING (premissa aceita no G1 — a
  alternativa é o teste automatizado). A mensagem de bloqueio já diz que o usuário pode ajustar
  `deploy.patterns`.
- Riscos: um caminho com espaços (`node "C:/meus projetos/scripts/install.mjs"`) escapa de `\S*` e não é
  bloqueado; copiar arquivos à mão para `~/.claude/team/` também não casa com os padrões — mas a **escrita**
  nesse diretório já é bloqueada por `protectedFileReason`. Limite conhecido, vai para "Limites" no README.
- O que fica mais difícil: mexer nos padrões default virou mudança de contrato de segurança — exige ADR.
