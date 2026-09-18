# ADR-004 — A decisão mais recente do usuário sobre um gate prevalece
Status: Aceito no G2 em 2026-09-17 · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

## Contexto
US-04, RF-08, RF-09, B-05. `recordDecision` grava aprovação em `approvals/<work>/<gate>.json` e reprovação em
`<gate>.rejected.json` (`core.mjs:311-314`); `checkApproval` só lê o primeiro (`:320-349`). Consequência: se o
usuário digita `APROVAR G1` e depois `REPROVAR G1 <motivo>` antes do `team move`, a aprovação continua valendo
e o fluxo avança contra a última decisão dele.

Restrição dominante: **RNF-07**. Este work item já tem um `G1.json` assinado pela v1.0, e o runtime será trocado
em DEPLOYING. Qualquer mudança no conjunto ou na ordem dos campos assinados invalidaria essa aprovação.

## Opções consideradas
1. **Arquivo único canônico `<gate>.json` com a última decisão** (aprovada ou reprovada), assinada.
   `checkApproval` exige `decision === 'approved'` — branch que já existe (`core.mjs:340`). Prós: um só lugar
   da verdade. Contras: exige varredura do `<gate>.rejected.json` legado da v1.0 para decidir qual é mais
   recente; muda `hooks.test.mjs` (que lê `G1.rejected.json`); um rollback para a v1.0 depois de uma reprovação
   deixa um arquivo com semântica diferente.
2. **Manter os dois arquivos e comparar `decided_at`; a mais recente vale.** Prós: nenhuma mudança de formato,
   leitura idêntica para dados da v1.0 **e** para dados da v1.1 lidos por um runtime v1.0 (rollback seguro);
   preserva literalmente o CA-04.3 ("nenhuma é apagada"); nenhum teste existente muda. Contras: dois arquivos;
   empate de timestamp precisa de regra; um `readFileSync` a mais por verificação.
3. **Log append-only por gate (`<gate>.jsonl`), última linha vale.** Prós: histórico no próprio artefato.
   Contras: formato novo, migração obrigatória dos arquivos da v1.0, e o histórico já está no
   `logs/orchestration.jsonl`. Esforço desproporcional para a v1.1.

## Decisão
Opção 2. `recordDecision` **não muda**. `checkApproval(root, state, gate)` passa a, depois de validar a
aprovação como hoje (assinatura, `decision`, `actor`, identidade do work item, revogação por retrabalho), ler
`approvals/<work>/<gate>.rejected.json`:

| situação do arquivo de reprovação | resultado |
|---|---|
| não existe / ENOENT | mantém o resultado atual |
| existe, assinatura **inválida**, ou `work_id`/`gate`/`state_at_decision` não correspondem | `{ valid:false, reason: 'registro de reprovação de <gate> inconsistente — peça ao usuário para decidir novamente' }` (fail-closed, RNF-04) |
| existe, válido, `decided_at` **>** `decided_at` da aprovação | `{ valid:false, reason: '<gate> foi reprovado pelo usuário em <ts>, depois da aprovação' }` |
| existe, válido, `decided_at` **≤** aprovação | mantém válido (CA-04.2: aprovar depois de reprovar volta a valer) |
| `decided_at` **iguais** (mesmo milissegundo) | a reprovação prevalece (empate resolvido de forma conservadora) |
| existe, válido, mas a aprovação **não** existe | já era `false` hoje; a razão passa a citar a reprovação |

A reprovação também é ignorada quando `revocations[gate]` já invalidou tudo — a ordem de avaliação mantém a
checagem de revogação antes, e o resultado é o mesmo (`valid: false`).

Por que a assinatura da reprovação é verificada: sem isso, qualquer arquivo solto em `.team/approvals/` travaria
o fluxo (negação de serviço). Um arquivo inconsistente **não pode** conceder aprovação — só negar — então
fail-closed é seguro e é o que o RNF-04 pede.

**CA-04.3 (histórico):** garantido pelo `appendLog` que já existe em `recordDecision` (`actor: 'user'`,
`event: 'approved'|'rejected'`, em ordem, append-only). Nenhum arquivo é apagado.

**CA-04.4/04.5:** saem de graça, porque o CLI (`team status --json`, `moveTo`) e o guard (`merge` e `deploy`)
usam `checkApproval`.

## Consequências
- Positivas: a última palavra do usuário vale nos dois sentidos; nenhuma mudança de formato, de assinatura ou
  de nome de arquivo, então o RNF-07 fica trivial e um rollback para a v1.0 permanece possível; os testes
  existentes de aprovação forjada, adulterada, revogada e fora de estado continuam valendo (CA-04.6).
- Negativas: a verdade sobre um gate passa a depender de dois arquivos e da comparação de timestamps; é mais
  uma leitura por verificação (irrelevante para o RNF-03, pois só ocorre quando o arquivo existe).
- Riscos: relógio do sistema alterado entre duas decisões pode inverter a ordem. Aceito: as duas decisões vêm
  do mesmo usuário, na mesma máquina, em minutos. O log de auditoria guarda a ordem real de gravação.
- O que fica mais difícil: B-11 (ligar a aprovação ao hash dos artefatos) continua exigindo um esquema de
  assinatura versionado — ver ADR-007.
