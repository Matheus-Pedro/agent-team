# ADR-006 — Aviso quando a decisão de gate vem incompleta
Status: Aceito no G2 em 2026-09-17 · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

## Contexto
US-08, RF-13, RF-14, B-18 — achado no G1 **deste** work item. O usuário digitou `APROVAR` sem o gate; as regex
de `prompt-approval.mjs:44-45` exigem `(g[1-4]|prod)`, `main()` retorna sem emitir nada (`:64`), e a sessão não
recebeu aviso algum. O usuário achou que havia aprovado e o fluxo ficou parado sem explicação.

Duas forças em tensão: avisar sempre que a mensagem "pareça" uma decisão **versus** não poluir a conversa nem
criar risco de registro acidental. O produto resolveu isso com uma regra explícita (US-08): só há aviso quando
a **primeira linha** contém apenas o verbo de decisão e, no máximo, um único token curto de gate.

O product também pediu (CA-08.4) que o aviso conheça o estado atual do work item — ou seja, o hook lê o estado
mesmo quando não registra nada.

## Opções consideradas
1. **Regex mais permissiva no lugar da atual** (`^(aprovar|...)\s*(\S*)\s*$`). Prós: mínimo. Contras: mistura
   reconhecimento, decisão e formatação no hook; difícil de testar caso a caso; a regra "verbo + no máximo um
   token de gate, com reprovação podendo ter motivo" não caberia em uma regex legível.
2. **Classificação estrutural em módulo próprio** (`lib/prompt-rules.mjs`): aparar, tirar pontuação final,
   tokenizar por espaço e decidir por tabela. Prós: testável sem spawn; espelha a separação
   `guard.mjs`/`guard-rules.mjs` que já existe; **não toca `core.mjs`** (arquivo disputado). Contras: um
   módulo a mais no runtime instalado.
3. **Avisar sempre que a mensagem contiver um verbo de decisão em qualquer posição.** Contras: quebra os
   CA-08.6 ("precisamos aprovar isso amanhã", "o cliente aprovou o orçamento") e viraria ruído em toda
   conversa sobre aprovação.

## Decisão
Opção 2. `runtime/lib/prompt-rules.mjs` exporta `classifyPrompt(prompt)` (forma do retorno em
[`contracts.md` §4](./contracts.md)). O hook fica só com I/O, leitura de estado e texto.

### Algoritmo
1. `first` = primeira linha; `rest` = restantes (continuam entrando no motivo, CA-08.8).
2. `T` = `first.trim()` sem pontuação final (`. ! : ,` e `…`), dividido por espaços em branco.
3. `verb`: `T[0]` em minúsculas ∈ {`aprovar`,`aprovo`,`aprovado`} → `approve`; ∈ {`reprovar`,`reprovo`,`rejeitar`,`rejeito`} → `reject`; senão `kind: 'none'` (fim).
4. `gateToken` = `T[1]` sem pontuação. `gate válido` = `/^(g[1-4]|prod)$/i`. `gate-like` = `/^(g\d{1,2}|g[a-z]|prod\w*)$/i`.

| condição | `kind` |
|---|---|
| `T.length === 1` | `intent` (CA-08.1, CA-08.3) |
| `verb=approve`, gate válido, `T.length === 2` | `decision` |
| `verb=approve`, gate válido, `T.length > 2` | `none` — conversa (`APROVAR G1 mas mude o RF-02`) |
| `verb=reject`, gate válido | `decision`; `T[2..]` = motivo (comportamento v1.0) |
| gate-like mas **não** válido (`G9`, `GX`, `G0`, `prodX`) e `verb=approve` com `T.length === 2` | `intent` (CA-08.2) |
| gate-like mas não válido e `verb=reject` (com ou sem motivo depois) | `intent` (CA-08.3) |
| `T[1]` não é gate-like (`APROVAR isso`, `aprovo o orçamento`) | `none` |

Mensagens de conversa cujo verbo não é o primeiro token (`acho que dá pra APROVAR G1`, `ok, pode seguir`,
`precisamos aprovar isso amanhã`) param no passo 3 → `none` (CA-08.6).

### Composição do aviso (`kind: 'intent'`)
Ordem obrigatória, tudo dentro de `try/catch`; qualquer falha resulta em **silêncio**:

1. `root = findTeamRoot(cwd)`; sem root → stdout vazio (CA-08.5).
2. `state = loadState(root)`; erro ou `!state.work` → stdout vazio (CA-08.5).
3. `waiting` = gate cujo `GATE_STATE[gate] === state.status` (mapa reverso calculado em `prompt-rules.mjs` a
   partir de `GATE_STATE`, importado de `core.mjs` — **sem alterar** `core.mjs`).
4. Com gate em espera (CA-08.1/08.2/08.3):
   `[agent-team] ⚠️ Você digitou "<typed>", mas NADA foi aprovado nem reprovado. O gate <G> está aguardando a sua decisão em <estado>. Digite exatamente: APROVAR <G>  (ou REPROVAR <G> <motivo>).`
   Para `verb=reject`, o comando em destaque é `REPROVAR <G> <motivo>`.
5. Sem gate em espera (CA-08.4):
   `[agent-team] ⚠️ Você digitou "<typed>", mas NADA foi aprovado nem reprovado: nenhum gate está aguardando decisão agora. O work item <id> está em <estado>. Peça o status ao Orchestrator (team status) antes de decidir.`

**Nada é escrito** neste caminho: `recordDecision` não é chamada, nenhum arquivo aparece em
`.team/approvals/<work>/` e nenhum evento entra no log (CA-08.7). O prefixo é `[agent-team]`, sem `BLOQUEADO`,
em português (CA-08.9).

O caminho de erro atual (`recordDecision` lança, por exemplo `APROVAR G2` fora do estado) **permanece** com a
mensagem de hoje (CA-08.8).

## Consequências
- Positivas: fecha o B-18 sem risco de registro acidental (a decisão continua exigindo o gate explícito); a
  classificação fica testável sem spawn; o hook passa a ler estado, mas segue sem escrever.
- Negativas: o hook roda em **toda** mensagem do usuário; o passo 1 (tokenizar) é barato, e a leitura de estado
  só ocorre em `kind: 'intent'`, que é raro. Um módulo a mais para instalar.
- Riscos: `APROVAR G1 mas mude o RF-02` fica silencioso, sem registro **e sem aviso** — o usuário pode achar
  que aprovou. É o que o G1 decidiu (regra da primeira linha) e o que os testes atuais exigem, mas vale
  documentar no README.
- **Teste existente que precisa mudar** (RNF-02): `tests/hooks.test.mjs:28` ("mensagens informais não são
  aprovação") espera `stdout` vazio para a mensagem `'aprovado'`. O CA-08.1 exige aviso para `APROVADO`
  isolado, em qualquer caixa. Esse caso sai da lista de silêncio e vira caso de aviso; os outros três da lista
  continuam como estão.
