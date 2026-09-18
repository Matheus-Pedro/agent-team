# ADR-007 — Compatibilidade e migração v1.0 → v1.1
Status: Aceito no G2 em 2026-09-17 · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

## Contexto
RNF-07, tratado como crítico pelo brief. Este próprio work item está em andamento com a v1.0 instalada e vai
trocar de runtime na fase DEPLOYING, **depois** de já ter G1 aprovado (assinado) e provavelmente G2 e G3. Se a
migração falhar, o work item que produziu a v1.1 fica impossível de terminar: as aprovações dadas deixariam de
valer e os gates seguintes não funcionariam.

Também há o caminho de volta: se o smoke do RNF-06 (b) reprovar, o usuário reinstala a v1.0. Os dados escritos
pela v1.1 até ali precisam continuar legíveis pela v1.0.

## Opções consideradas
1. **Versionar os formatos (`version: 2`) com migração na leitura.** Prós: liberdade para mudar estado,
   config e assinatura. Contras: custo e risco altos para o que a v1.1 precisa; obriga a escrever e testar
   migração de verdade; rollback para a v1.0 passa a ser impossível sem migração inversa.
2. **Congelar os formatos: toda mudança é aditiva ou apenas de interpretação.** Prós: migração vira
   não-evento; rollback continua possível; o teste do RNF-07 fica simples (ler dados no formato v1.0 e
   verificar que tudo funciona). Contras: impede mudanças que seriam desejáveis (ligar a aprovação aos
   artefatos, B-11), que ficam para a v1.2.
3. **Migração automática no `install.mjs`** (reescrever `.team/` dos projetos). Contras: o instalador não sabe
   quais projetos existem, e reescrever `.team/` de terceiros é ação destrutiva sem aprovação. Rejeitado.

## Decisão
Opção 2 — **os formatos em disco são congelados na v1.1**. Regras que os implementadores têm de respeitar:

1. **`signable()` é intocável.** Nem os campos, nem a ordem, nem a serialização
   (`JSON.stringify([work_id, gate, decision, decided_at, state_at_decision, actor])`). Mudar qualquer coisa
   ali invalida o `G1.json` já assinado deste work item. O campo `note` continua **fora** da assinatura, como
   na v1.0.
2. **A chave não se move e não é regerada.** `KEY_FILE = <TEAM_HOME>/approval.key`, `TEAM_HOME` respeitando
   `AGENT_TEAM_HOME`. `scripts/install.mjs:62-68` só gera a chave quando ela não existe — comportamento
   preservado; nenhuma tarefa desta versão pode alterá-lo.
3. **`version` permanece `1`** em `config.json` e `state.json`. Não há campo novo persistido em nenhum dos dois.
4. **Nomes de arquivo de aprovação preservados**: `<gate>.json` e `<gate>.rejected.json`. O ADR-004 muda a
   *interpretação* (compara timestamps), não o formato — inclusive para dados escritos pela v1.0.
5. **Campos novos só de saída**: a chave `git` do `team status --json` é aditiva e não é persistida
   (ADR-001). Consumidores que ignoram chaves desconhecidas não quebram.
6. **Defaults de config não são retroativos, por desenho.** `loadConfig` faz
   `deploy: { ...def.deploy, ...(cfg.deploy || {}) }` e `gates: { ...def.gates, ...(cfg.gates || {}) }`, e
   `team init` grava as duas chaves, então o valor do usuário **substitui** o default. Isso garante o CA-06.2
   (config existente intacta) e implica que os padrões do ADR-002 e os gates do ADR-008 valem **só em projetos
   novos**. Projetos existentes precisam de edição manual, que só o usuário pode fazer — e que este ciclo já
   está fazendo pelo ADR-010.
   Alternativa descartada: unir os arrays (default ∪ usuário). Faria a proteção chegar a projetos antigos, mas
   devolveria padrões que o usuário removeu de propósito, contrariando "a config é do usuário".
7. **Leitura tolerante, sem escrita de migração.** Nenhum comando da v1.1 reescreve `.team/` só para
   atualizar formato. Estado sem `revocations`, sem `tasks` ou sem `history` continua sendo lido (código atual
   já usa `?.` e `||=`).

**Teste obrigatório (RNF-07)** — `tests/migration.test.mjs`, novo:
monta um `.team/` com **fixture no formato v1.0** (config sem os padrões do ADR-002, com todos os gates
ligados; `state.json` version 1; um `G1.json` assinado com o `signable()` atual e a chave do `AGENT_TEAM_HOME`
de teste) e verifica que a v1.1: (a) valida o G1; (b) permite `move` para ARCHITECTING; (c) aceita `APROVAR G2`
em seguida; (d) mostra `G1.approved = true` no `status --json`; (e) mantém o `deploy.patterns` antigo intacto
depois de `loadConfig`. Um segundo caso monta também um `G1.rejected.json` mais **antigo** que o `G1.json` e
verifica que o gate continua aprovado (ADR-004, dado legado).

**Ordem de troca do runtime em DEPLOYING** (para o devops):
1. `--claude-dir <temp>` (G4) e smoke do RNF-06 (b) — nenhuma sessão real é afetada;
2. só depois, com `APROVAR PROD`, instalação no diretório real;
3. rollback = reinstalar a v1.0 a partir do commit anterior; os dados em `.team/` continuam válidos pelas
   regras 1 a 5.

## Consequências
- Positivas: o RNF-07 deixa de ser risco; o work item em andamento sobrevive à troca do runtime; rollback é
  possível sem migração inversa.
- Negativas: a v1.1 não pode melhorar nada de formato — B-11 (aprovação ligada ao hash dos artefatos) fica
  bloqueado até a v1.2, que precisará de um esquema de assinatura versionado (`sig_version` no registro, com
  verificação dos dois formatos durante uma janela).
- Riscos: a regra 6 deixa projetos existentes (inclusive este) sem a proteção do ADR-002 até o usuário editar
  a config. Mitigação: README e CHANGELOG com o trecho pronto, e ADR-010 para este repositório.
- O que fica mais difícil: qualquer PR que toque `signable`, `KEY_FILE`, `approvalFile` ou `version` deve ser
  recusado na revisão sem um ADR que o substitua.
