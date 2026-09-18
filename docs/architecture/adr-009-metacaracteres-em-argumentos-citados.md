# ADR-009 — Metacaracteres dentro de aspas não invalidam a chamada isolada do CLI
Status: Adiado para a v1.2 (aceito no G2 em 2026-09-17; retirado da v1.1 na revisão de 2026-09-17) · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

> **Este ADR não vale na v1.1.** A regra de aspas descrita abaixo mostrou-se insegura na revisão independente
> e a US-07 (NICE_TO_HAVE) saiu do escopo. `isStandaloneTeamCall` segue a regra estrita da v1.0: qualquer
> metacaractere, em qualquer posição, inclusive entre aspas, invalida a chamada isolada. O texto original fica
> preservado como registro; veja **"Por que foi adiado"** no fim.

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
| escape `\"` fora e dentro de aspas duplas | tratado como caractere literal, não fecha a aspa | — ⚠️ **linha incorreta**: é a origem da falha; ver "Por que foi adiado" |

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

## Por que foi adiado
Revisão independente de 2026-09-17 (`.team/work/W-001-evolucao-v1-1/results/TR-code-reviewer.md`, achado 2,
BLOCKER), decisão do Orchestrator registrada em `decisions.md` ("Revisão: MUDANÇAS NECESSÁRIAS").

**O que falhou.** O revisor demonstrou, executando em `powershell.exe` e em `bash`, comandos em que o scanner
concluía que um trecho estava entre aspas enquanto o shell real concluía que não estava. Nesses casos
`isStandaloneTeamCall` devolvia `true`, e como ela é consultada **antes** de qualquer regra de negação, o guard
liberava o comando inteiro, inclusive um segundo comando encadeado. A causa está na **regra**, não só no código:
a tabela deste ADR tratava o escape de aspa dupla com barra invertida como literal nos dois shells, e isso não é
verdade para o PowerShell; e a tabela não previa formas de citação que só um dos shells reconhece.

**O erro de raciocínio.** A seção "Consequências" afirmava que a mudança era *fail-closed por construção*,
porque um caso não previsto faria o comando ser rejeitado da lista branca. Isso só vale quando o scanner erra
para o lado de "não está entre aspas". Um scanner que erra para o lado de "está entre aspas" **esconde**
metacaracteres reais, e o resultado é fail-open. Em uma lista branca, qualquer divergência entre o parser e o
shell é explorável; a premissa deveria ter sido o contrário.

**O que uma próxima tentativa precisa resolver** (pré-requisitos, não solução):
1. **Um modelo de citação por shell, não um modelo comum.** PowerShell e bash divergem no caractere de escape,
   no significado da barra invertida dentro e fora de aspas, em formas de citação exclusivas de cada um e no
   tratamento de argumentos passados a executáveis nativos. A regra precisa saber qual shell vai executar (o
   harness informa a ferramenta: `Bash` ou `PowerShell`) e ser especificada separadamente para cada um.
2. **Escapes.** Toda sequência de escape reconhecida por **qualquer** dos dois shells tem de ser tratada de modo
   conservador: na dúvida, o texto é considerado **fora** de aspas.
3. **Aspas não ASCII.** O PowerShell aceita aspas tipográficas como delimitadores; qualquer caractere que algum
   shell trate como aspa precisa entrar no modelo, ou o comando que o contiver deve ser rejeitado.
4. **Direção do erro explícita.** O critério de aceite tem de ser "nenhuma entrada em que o scanner vê aspas e o
   shell não vê", verificado com execução real nos dois shells (como fez o revisor), e não só com testes de
   unidade sobre o scanner.
5. **Alternativa a considerar primeiro:** a opção 4 deste ADR (motivo e título por arquivo ou stdin) elimina o
   problema em vez de modelá-lo, e provavelmente é mais barata que um parser de shell correto.

Efeitos na v1.1: `runtime/lib/shell.mjs` deixa de ser usado pelo guard (removê-lo ou mantê-lo sem uso é decisão
da faixa A; ele não pode continuar no caminho de decisão); o teste que afirmava o caso inseguro
(`tests/guard.test.mjs`, apontado pelo revisor) tem de ser removido ou invertido para exigir bloqueio; a instrução do `SKILL.md` que manda evitar `; & | > <` em motivos e títulos **continua valendo**; o
CA-07.2 (acentos) não dependia deste ADR.
