# Templates do Orchestrator

## plan.md — `.team/work/<id>/plan.md`

```markdown
# Plano — <work-id> <título>
Trilha: P|M|G (motivo) · Branch: team/<work-id> · Atualizado: <data>

## Objetivo
<problema e resultado esperado, em 2–4 linhas>

## Pedido original
> <texto literal do usuário>

## Requisitos conhecidos / restrições
- ...

## UNKNOWN
| # | Pergunta | Quem responde (usuário/agente) | Status |

## Escopo
- REQUIRED:
- NICE_TO_HAVE:
- OUT_OF_SCOPE:

## Tarefas (DAG)
| ID | Agente | Tarefa | Depende de | Escopo de arquivos | Pronto quando | Status |
|---|---|---|---|---|---|---|

## Paralelismo
- Lote 1: T1
- Lote 2 (após G2): T3 ∥ T4 — escopos disjuntos: `src/Api/**` × `web/**`

## Riscos
- ...
```

## Brief — `.team/work/<id>/briefs/<tarefa>-<agente>.md`

```markdown
# Brief — <tarefa> (<agente>)
Work item: <work-id> — <título> · Trilha: <P|M|G> · Fase: <estado>

## Objetivo
<o que precisa existir ao final, em 1–3 linhas>

## Critério de pronto
- ...

## Entradas aprovadas (leia antes de começar)
- Requisitos: `docs/requirements/<id>-<slug>.md` (US-01..US-04; CA relevantes: ...)
- Arquitetura: `docs/architecture/adr-003-*.md`, `docs/architecture/overview.md`
- Contrato: `docs/api/openapi.yaml` (tags/paths: ...)
- Modelo: `docs/data/model.md`
- Contexto do repositório: `.team/work/<id>/context.md`

## Decisões vigentes
- <decisão> (fonte: ADR-003 / usuário no G2 / decisions.md)

## Restrições
- <ex.: não alterar o contrato existente de /v1/orders>
- <ex.: .NET 8, EF Core, padrão de pastas atual>

## Escopo de arquivos
- Pode alterar: `src/Api/Products/**`, `tests/Api.Tests/Products/**`, `src/Api/Migrations/**`
- Não pode alterar: `web/**`, `docs/**`, qualquer outro

## Git
- Branch: `team/<work-id>` (já criada). Commits pequenos nesta branch. Sem push/merge.

## Dependências e resultados anteriores
- T2 architect: <resumo de 1–3 linhas> — `.team/work/<id>/results/T2-architect.md`

## Se for correção (retrabalho n/2)
- Achados a corrigir: <lista com evidências> — fonte: `results/T5-qa-engineer.md`

## Saída esperada
- <código + testes unitários | documento X | plano de deploy ...>
- Responda no formato de Resultado do contrato comum do time.
```

## Pacote de aprovação (mensagem ao usuário)

```markdown
## ⏸️ Gate <Gx> — <Requisitos | Arquitetura | Merge | Deploy <ambiente> | PRODUÇÃO> · <work-id>

**Aprovar:** digite `APROVAR <Gx>` · **Reprovar:** `REPROVAR <Gx> <motivo>`
(observações podem ir nas linhas seguintes à aprovação)

### O que você está aprovando
- <artefato> — `caminho` — <1 linha>

### Destaques
- <decisão / requisito / mudança principal> — <por quê>

### Trade-offs e alternativas descartadas
- ...

### Evidências            ← obrigatório em G3, G4 e PROD
- Quality Gate: <veredito> (`results/T5-qa-engineer.md`)
- Revisão: <veredito> (`results/T7-code-reviewer.md`)
- Testes: `<comando>` → <resultado>

### Riscos, ressalvas e UNKNOWN
- ...

### O que acontece depois da aprovação
- <G1: architect define arquitetura, contrato e modelo>
- <G3: "merge local de team/<id> em main com --no-ff" OU "push da branch + PR">
- <G4: devops executa os passos 1–N do plano em <ambiente>; rollback: ...>
```

Conteúdo mínimo por gate:
- **G1:** histórias, RF/RNF, critérios de aceitação (resumo), escopo e fora de escopo, premissas, perguntas respondidas e pendentes.
- **G2:** visão da arquitetura, ADRs propostos, resumo do contrato (endpoints), modelo de dados (entidades), plano de trabalho com o paralelismo e riscos técnicos.
- **G3:** o que foi implementado × critérios, Quality Gate, revisão, `git diff --stat`, ressalvas, follow-ups e o método de merge.
- **G4:** o plano de deploy completo (ambiente, versão, passos, smoke, rollback, impacto, variáveis necessárias).
- **PROD:** o mesmo que o G4 para produção, mais o resultado do deploy não produtivo.

## Escalação (limite de retrabalho ou bloqueio)

```markdown
## 🛑 Preciso de você — <work-id> / <tarefa>
**Problema:** ...
**Tentativas:** 1) ... → resultado; 2) ... → resultado
**Causa provável:** ...
**Opções:** A) ... (recomendado — por quê) · B) ...
**O que preciso para continuar:** ...
```

## Resumo final

```markdown
## ✅ <work-id> — <título> · DONE

**Entregue:** <1–3 linhas>
**Decisões:** ADR-00X <título> · ...
**Evidências:** Quality Gate <veredito> · Revisão <veredito> · `<comando>` → <resultado>
**Merge/Deploy:** <como e onde>
**Pendências e ressalvas:** ...
**Follow-ups sugeridos:** ... (`.team/work/<id>/followups.md`)
**Próximos passos:** ...
```
