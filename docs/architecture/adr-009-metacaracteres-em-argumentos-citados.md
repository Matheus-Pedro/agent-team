# ADR-009 — Metacaracteres dentro de aspas não invalidam a chamada isolada do CLI
Status: Aceito no G2 em 2026-09-17 · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

## Contexto
US-07 (NICE_TO_HAVE), RF-12, B-09. `isStandaloneTeamCall` (`guard-rules.mjs:27-29`) exige que o comando case
com `TEAM_CLI_RE` **e** não contenha nenhum caractere de `SHELL_META_RE = /[;&|<>`\r\n]|\$\(/` — testado no
comando **inteiro**, inclusive dentro de aspas. Resultado: `team move ... --reason "G1 ok; ajustar RF-02"` é
recusado, e o `SKILL.md:45` manda o Orchestrator evitar esses caracteres. Motivos de auditoria ficam mais
pobres e o Orchestrator reescreve texto do usuário.

A razão de existir do teste é real: a lista branca do CLI não pode virar veículo para executar um segundo
comando (`team status && rm -rf .team`). Só o que está **fora** das aspas tem esse poder.

## Opções consideradas
1. **Manter como está.** Prós: zero risco. Contras: mantém o atrito e a instrução defensiva no SKILL.md.
2. **Regex que "pula" trechos entre aspas.** Contras: regex aninhada e frágil com escapes; exatamente o que o
   brief pede para evitar.
3. **Tokenizar o comando em um módulo próprio**, marcando cada caractere como "fora de aspas", "em aspas
   simples" ou "em aspas duplas", e aplicar regras diferentes a cada contexto. Prós: verificação estrutural;
   erro de parsing resulta em comando **não reconhecido** como isolado, ou seja, mais restritivo. Contras: um
   módulo novo; tem de considerar as diferenças entre POSIX e PowerShell.
4. **Passar motivo e título por arquivo ou stdin em vez de argumento.** Prós: elimina o problema. Contras:
   muda o contrato do CLI e a forma de invocação do Orchestrator, com ganho pequeno.

## Decisão
Opção 3, em `runtime/lib/shell.mjs` (novo):

```js
export function scanQuoting(command)  // varredura de 1 passada → segmentos { text, quote: null | "'" | '"' }
export function unquotedMeta(command) // metacaracteres reais, por contexto; null quando não há
```

Regras por contexto, pensadas para valer nos dois shells de referência (Git Bash e PowerShell):

| contexto | proibido | liberado |
|---|---|---|
| fora de aspas | `; & \| < > \` \r \n $( ` (o `SHELL_META_RE` atual) | resto |
| dentro de `"..."` | `` ` ``, `$(`, `${` — PowerShell **e** POSIX expandem subexpressão dentro de aspas duplas | `; & \| < >`, acentos, `$VAR` simples |
| dentro de `'...'` | nada | tudo (literal em POSIX e em PowerShell) |
| aspas não fechadas | o comando **não** é chamada isolada | — |
| escape `\"` fora e dentro de aspas duplas | tratado como caractere literal, não fecha a aspa | — |

`isStandaloneTeamCall(command)` passa a ser `TEAM_CLI_RE.test(slash(command)) && unquotedMeta(command) === null`.
Nada mais muda: a função é uma **lista branca** consultada no início de `evaluateToolCall` (`:146`), então
qualquer erro de parsing só faz o comando cair nas regras de negação seguintes — que, para um comando que cita
`.claude/team`, bloqueiam. A mudança é fail-closed por construção.

`$VAR` simples dentro de aspas duplas continua permitido porque é exatamente assim que a invocação documentada
funciona (`node "$HOME/.claude/team/bin/team.mjs"`) e já é permitida hoje.

**Acentos (CA-07.2)**: não exigem mudança de código. O título sem acento em `state.json` foi precaução do
Orchestrator, não falha observada (Q-07 respondida em `decisions.md`); `JSON.stringify` preserva os caracteres e
os arquivos são escritos em UTF-8. É verificação do QA nos dois shells, não implementação.

## Consequências
- Positivas: motivos e títulos de auditoria passam a aceitar o texto real do usuário; o `SKILL.md` perde a
  instrução defensiva; o tokenizador fica disponível para, no futuro, extrair alvos de busca de comandos de
  shell (o que hoje é o limite do ADR-003/Q-05).
- Negativas: mais um módulo no runtime instalado e mais uma varredura por chamada de Bash — O(n) sobre o
  comando, irrelevante para o RNF-03.
- Riscos: shells reais têm mais casos do que a tabela (`<<` heredoc, `@'...'@` do PowerShell, `--%`). Como um
  caso não previsto faz o comando ser **rejeitado** da lista branca, o erro é sempre para o lado seguro. O QA
  tem de manter os casos compostos de `guard.test.mjs` (`&&`, `;`, `$( )`, redirecionamento fora das aspas)
  bloqueados (CA-07.3) e acrescentar: metacaractere dentro de aspas simples e duplas liberado, `$(` dentro de
  aspas duplas bloqueado, aspa não fechada rejeitada.
- É NICE_TO_HAVE: sai do ciclo sem afetar as demais tarefas, desde que a nota do SKILL.md continue em pé.
