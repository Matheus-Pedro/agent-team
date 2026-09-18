# ADR-010 — Segurança do dogfooding: proteger este ciclo pela config do repositório
Status: Aceito no G2 em 2026-09-17 · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

## Contexto
B-02, B-12, decisões Q-02, Q-03 e Q-06 do G1. Duas restrições se cruzam:

1. O guard que está **instalado** é o da v1.0. O código do ADR-002 só passa a valer depois de instalado, o que
   acontece em DEPLOYING — isto é, **no fim** deste work item. Até lá, a única proteção contra um agente
   reinstalar ou remover o próprio guard é a config deste projeto (premissa registrada no G1).
2. Neste repositório, `node runtime/bin/team.mjs ...` e `node runtime/hooks/*.mjs` **não** são reconhecidos
   pelo guard (`guard-rules.mjs:23-28` só reconhece o caminho do runtime instalado), usam o `TEAM_HOME` real
   (`core.mjs:10-11`) e `recordDecision` é exportada (`:291`). Ou seja: código em desenvolvimento, ainda não
   revisado, pode alterar o estado real ou assinar uma decisão (B-12). Hoje isso está mitigado apenas por um
   compromisso do Orchestrator (`decisions.md`, 2026-09-17), que é uma promessa, não um controle.

## Opções consideradas
1. **Só o compromisso do Orchestrator.** Prós: nada a fazer. Contras: não vale para subagentes; uma promessa
   em prompt não é controle técnico; é exatamente o tipo de garantia que este work item existe para substituir.
2. **Padrões em `deploy.patterns` da config deste repositório**, aplicados pelo usuário antes de IMPLEMENTING.
   Prós: usa um mecanismo que já existe, vale para todos os agentes, custa uma edição. Contras: só o usuário
   pode aplicar; não cobre `node -e` importando a lib.
3. **Fazer o runtime recusar `TEAM_HOME` fora de `~/.claude/team` quando executado do repositório.** Prós:
   controle no código. Contras: é o B-12 estrutural (esforço G, adiado para a v2) e exigiria alterar
   `core.mjs`/`bin` justamente no ciclo em que eles estão sendo mexidos.
4. **`enforce: false` neste repositório durante o desenvolvimento.** Rejeitado: desligaria toda a proteção,
   inclusive a de merge, no projeto onde ela é mais necessária.

## Decisão
Opção 2. **Ação do usuário** (a config só pode ser editada por ele): acrescentar aos arrays existentes de
`.team/config.json` deste repositório, sem remover nada do que já está lá.

Em `deploy.patterns`, acrescentar os três itens:

```json
"\\b(un)?install:claude\\b",
"\\bnode(\\.exe)?\\s+\\S*scripts/(un)?install\\.mjs",
"\\bnode(\\.exe)?\\s+\\S*runtime/(bin/team|hooks/[\\w-]+)\\.mjs"
```

Em `deploy.production_patterns`, acrescentar o item:

```json
"^(?!.*--claude-dir).*(\\b(un)?install:claude\\b|\\bnode(\\.exe)?\\s+\\S*scripts/(un)?install\\.mjs)"
```

Os dois primeiros de `patterns` e o de `production_patterns` são os mesmos que o ADR-002 leva para o default do
código, então este repositório fica com a proteção da v1.1 desde já e, depois da instalação, config e código
dizem a mesma coisa. O terceiro é específico do dogfooding (Q-06) e **não** vai para o default: em outro
projeto, `runtime/bin/team.mjs` não significa nada.

Efeitos verificados por leitura do código:

- `detectDeploy` normaliza `\` → `/` e usa flag `i`, então os padrões valem em PowerShell e em Git Bash;
- `npm test` não casa com nenhum padrão, e os testes usam `AGENT_TEAM_HOME` temporário (`tests/helpers.mjs:6-7`)
  e processos filhos, que o guard não vê;
- `git add`, `git diff` e `Read` desses arquivos continuam livres — os padrões exigem execução via `node`;
- `--dry-run` do instalador também fica bloqueado fora de DEPLOYING (premissa aceita no G1);
- o medidor de desempenho do RNF-03 tem de **spawnar** o guard de dentro de um script Node (como
  `tests/hooks.test.mjs` já faz), nunca chamar `node runtime/hooks/guard.mjs` na linha de comando, que é
  justamente o que o terceiro padrão bloqueia.

## Consequências
- Positivas: o B-02 fica coberto neste ciclo, antes de a v1.1 existir; o B-12 sai de "promessa" para
  "bloqueio do guard"; a mesma edição serve de exemplo pronto para o README (projetos existentes não recebem os
  defaults novos — regra 6 do ADR-007).
- Negativas: enquanto a edição não for aplicada, o ciclo segue com a brecha aberta. É pré-requisito de
  IMPLEMENTING, e o Orchestrator deve tratá-la como tal.
- Riscos / não coberto: `node -e "import('./runtime/lib/core.mjs')..."` e qualquer script intermediário que
  importe a lib não casam com os padrões (limite conhecido, registrado nos "Limites" do README); a solução
  estrutural é o B-12 na v2.
- O que fica mais difícil: depois da instalação da v1.1, dois lugares descrevem os mesmos padrões (default do
  código e config deste repositório). A revisão precisa conferir se continuam equivalentes.
