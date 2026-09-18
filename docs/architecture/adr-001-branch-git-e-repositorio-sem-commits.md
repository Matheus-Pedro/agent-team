# ADR-001 — Resolução da branch git e repositório sem commit base
Status: Aceito no G2 em 2026-09-17 · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

## Contexto
US-01, RF-01, RF-02, B-01. Hoje `currentBranch()` (`guard-rules.mjs:95-105`) roda
`git rev-parse --abbrev-ref HEAD` e devolve `null` em qualquer falha. Verificado pelo Orchestrator (Q-08) e
reconfirmado por mim neste repositório: numa branch **sem commits** esse comando sai com 128, então
`currentBranch()` devolve `null`, `detectMerge` não reconhece a principal (`:67`) e `git commit` na `main`
**é liberado** — *fail-open* na garantia central do produto.

Quatro situações hoje colapsam em `null` ou numa string: branch normal, branch principal sem commits (*unborn*),
HEAD destacado (devolve a string `"HEAD"`) e indeterminada (git ausente, timeout, repositório corrompido).

> **Atualização 2026-09-17 (pós-implementação do `git.mjs`, T3):** o risco aberto deste ADR foi fechado. Em HEAD
> destacado, `git symbolic-ref --quiet --short HEAD` sai com **código 1** e stdout vazio, então o caso cai em
> `detached` e o CA-01.7 se mantém. Também verificados: `git` fora do PATH → `ENOENT` → `unknown`; `.git`
> corrompido → status 128 → `unknown`. Os 4 exports aditivos do módulo foram aceitos e documentados em
> `contracts.md` §1.
O RNF-03 limita o custo: cada execução de `git` no Windows custa dezenas de milissegundos e o guard roda em
**toda** chamada de ferramenta.

## Opções consideradas
1. **Continuar com `rev-parse --abbrev-ref HEAD` e tratar `null` como principal.** Prós: uma linha. Contras:
   bloqueia todo comando git em diretório sem git; não distingue *unborn* de erro, então a mensagem do
   CA-01.1 ("crie o commit base") apareceria em situações erradas.
2. **`git status --porcelain=v2 --branch` e parsear.** Prós: um comando para tudo. Contras: parsing de texto
   (frágil, é o que o brief pede para evitar); custo bem maior que `symbolic-ref` em repositório grande.
3. **`git symbolic-ref --quiet --short HEAD`, com detecção de repositório por `fs` e sonda de commit
   preguiçosa.** Prós: `symbolic-ref` **funciona em branch sem commits** (verificado: devolve `main`, exit 0);
   os três estados saem do código de saída, sem regex; 1 spawn no caminho comum. Contras: mais um módulo;
   depende de códigos de saída do git (contrato estável, mas exige teste).
4. **Ler `.git/HEAD` diretamente, sem spawn.** Prós: custo zero. Contras: reimplementar git (worktrees,
   `.git` como arquivo, `gitdir:`, packed-refs); errar aqui é *fail-open* silencioso.

## Decisão
Opção 3, num módulo novo `runtime/lib/git.mjs` — o **único** lugar do runtime que executa `git`. API e
algoritmo em [`contracts.md` §1](./contracts.md). `guard-rules.mjs` e `bin/team.mjs` consomem `BranchInfo`
estruturado; ninguém mais chama `execFileSync`.

**Frases em fonte única.** As duas mensagens dos CA-01.1 e CA-01.2 são exportadas por `git.mjs`
(`missingBaseCommitMessage`, `unknownBranchMessage`) porque têm **dois consumidores em faixas paralelas**: o
guard as acrescenta à mensagem de bloqueio e o CLI as emite como aviso via `gitWarnings`. Duplicar o texto o
faria divergir. Como as duas são lidas pelo usuário **e** pelo agente, nenhuma pode falar na segunda pessoa —
texto normativo em `contracts.md` §1.

**Separação da regra de histórico.** `detectMerge(command, branch, mainBranches)` é dividido em:
`classifyGitCommand(command, mainBranches) → { historyAltering, targetsMain, label } | null` (só texto do
comando, sem git) e a combinação com `BranchInfo` em `evaluateToolCall`. `historyAltering` cobre
`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `push`, `update-ref refs/heads/<main>`,
`branch -f|--force|-M|-D <main>` e `gh pr merge` — o mesmo conjunto de hoje, agora nomeado.

Tabela de decisão para comando que altera histórico:

| `BranchInfo.kind` | alvo | resultado |
|---|---|---|
| `no-repo` | — | regra de histórico não se aplica (as de deploy e de caminho continuam valendo) |
| `branch`, nome em `main_branches` | principal | exige `MERGING` + G3, como na v1.0. Se `hasBaseCommit(cwd) === false`, a mensagem **acrescenta** a frase do commit base (CA-01.1) |
| `branch`, nome fora de `main_branches` | — | permite (CA-01.5) |
| `detached` | tratado como "não principal" | permite (CA-01.7, premissa aprovada: igual à v1.0). **Verificado**: `symbolic-ref --quiet` sai com 1 e stdout vazio, então HEAD destacado cai aqui e não em `unknown` |
| `unknown` | — | **bloqueia**: `não foi possível identificar a branch atual (<detail>); comandos que alteram histórico ficam bloqueados. Peça ao usuário para verificar o repositório.` (CA-01.2) |

`switchesToMain` (`git checkout/switch <main>` na mesma linha) continua forçando `targetsMain`, inclusive
quando `kind` é `detached` ou `unknown`.

**Custo (RNF-03).** `resolveBranch` só é chamada quando o comando menciona `git`/`gh` (guarda que já existe) e
gasta **1** spawn; `hasBaseCommit` é preguiçosa e só roda quando o guard **já decidiu bloquear** e precisa
compor a mensagem, ou quando o CLI monta o `status`. Ambas memoizadas por `cwd` no módulo.

**CLI.** `gitWarnings(cwd, mainBranches)` alimenta `team status` (texto e `--json`) e `team init`. Sem git,
lista vazia — nenhum aviso e nenhuma falha (CA-01.6).

**Compatibilidade de teste.** `deps.getBranch` continua sendo o ponto de injeção; o valor é normalizado por
`normalizeBranchInfo` (exportada por `git.mjs`): `string → {kind:'branch', name}`, `null` ou objeto sem `kind`
→ `{kind:'unknown'}`, `BranchInfo` passa direto. Os testes atuais de `guard.test.mjs` passam strings e
continuam valendo sem alteração. `resetGitCache()` existe para que o teste possa invalidar a memoização entre
cenários; é **de uso exclusivo de teste** — o guard e o CLI são processos curtos e chamá-la anularia o ganho
que sustenta o RNF-03.

## Consequências
- Positivas: fecha o *fail-open* do B-01; a mensagem diz quem cria o commit base (o usuário, no terminal dele
  — Q-01); o git fica isolado em um módulo, testável com `AGENT_TEAM_HOME`/diretórios temporários.
- Negativas: um comando git com branch indeterminada passa a ser bloqueado — é a inversão pedida pelo RNF-04,
  mas é um bloqueio novo que pode surpreender (por exemplo, `git` fora do PATH do agente).
- Riscos: o exit 1 do `symbolic-ref --quiet` para HEAD destacado **está verificado** (`tests/git.test.mjs`,
  16 testes) — risco encerrado. Continua em aberto o caminho UNC (`\\wsl.localhost\...`), não exercitado por
  falta de share montado: se o git recusar, cai em `unknown` e bloqueia, que é o lado seguro (RNF-04). O QA
  deve tentar exercitá-lo no smoke, se houver ambiente.
- O que fica mais difícil: qualquer regra futura que precise de mais fatos do git paga um spawn a mais; a
  resposta correta será estender `git.mjs` com uma chamada combinada, não espalhar `execFileSync`.
