# ADR-003 — O guard avalia o **alvo** da busca, não o texto do padrão
Status: Aceito no G2 em 2026-09-17 · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

## Contexto
US-03, RF-05, RF-06, RF-07, B-03 e B-04. Hoje (`guard-rules.mjs:136-140`) Read, Grep e Glob são avaliados pela
concatenação `file_path + pattern + glob`, em minúsculas: qualquer menção a `approval.key` ou a `.claude/team`
bloqueia a chamada. Como esses literais existem no próprio código, nos testes e no README, os agentes não
conseguem pesquisar o repositório — atrito 3, e **eu mesmo fui bloqueado duas vezes** enquanto escrevia este
ADR (uma vez por ter `approval.key` no texto de um script de inspeção, outra por ter `.claude/team`).

Ao mesmo tempo, a verificação por menção literal deixa a brecha B-04: um `Grep` com `path` em `~` ou
`~/.claude` e um padrão hexadecimal devolveria o conteúdo da chave sem nunca citar o nome do arquivo. Quem tem
a chave forja aprovação, o que derruba a garantia central do produto.

## Opções consideradas
1. **Continuar avaliando o padrão, com exceções** (por exemplo, liberar quando o alvo está dentro do projeto).
   Prós: mudança pequena. Contras: não fecha o B-04; mantém o falso positivo quando o alvo é o projeto inteiro
   e o padrão cita o literal; continua sendo regex sobre texto livre.
2. **Avaliar só o alvo, com comparação de strings normalizadas (`slash` + `toLowerCase` + `startsWith`).**
   Prós: simples. Contras: `startsWith` casa `C:/a/barbaz` com `C:/a/bar`; `toLowerCase` está errado em
   sistemas com caixa significativa; não resolve `..`, UNC nem `\\?\`.
3. **Avaliar só o alvo, com ancestralidade estrutural via `path.relative`.** Prós: resolve `..`, separadores,
   letra de unidade, UNC e caixa **com a semântica da plataforma** (verificado: `path.win32.relative` compara
   sem diferenciar caixa; `path.posix.relative` diferencia); evita a armadilha de prefixo. Contras: não
   resolve link simbólico/junction sem I/O.
4. **Comparar caminhos reais (`fs.realpathSync`).** Prós: cobre link simbólico. Contras: custo de I/O em todo
   Read/Grep/Glob (RNF-03), e falha quando o alvo ainda não existe — teria que ter *fallback* para o caminho
   lexical de qualquer forma.

## Decisão
Opção 3, num módulo novo `runtime/lib/paths.mjs`:

```js
export function normalizeTarget(cwd, p)            // path.resolve(cwd, p) + remoção de prefixo \\?\ e \\?\UNC\
export function isInside(parent, child)            // rel = path.relative(parent, child);
                                                   // rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
export function isSameOrAncestor(target, file)     // normalizeTarget iguais || isInside(target, file)
export function staticPrefix(globPattern)          // prefixo literal antes do 1º metacaractere * ? [ ] { }
```

Usa `node:path` **da plataforma** (nunca `path.posix` nem `toLowerCase` manual), que é o que dá a semântica de
caixa correta em cada sistema.

### Alvos de cada ferramenta (`searchTargets`)

| ferramenta | alvos considerados | **nunca** considerado |
|---|---|---|
| `Read` | `file_path` | — |
| `Grep` | `path` (ou `cwd` quando ausente) **+** `staticPrefix(pattern)` e `staticPrefix(glob)` quando o prefixo é absoluto ou começa com `..` | o texto de `pattern`, `glob`, `type` |
| `Glob` | `path` (ou `cwd`) **+** `staticPrefix(pattern)` quando absoluto ou começa com `..` | o texto de `pattern` |

O prefixo estático fecha o caso `Glob(pattern: "C:/Users/<u>/.claude/team/**")` sem `path`, e **não**
reintroduz falso positivo: um padrão de busca textual como `\.claude/team` é relativo e não começa com `..`,
então é descartado.

### Regras

Sendo `KEY_FILE` o arquivo da chave e `TEAM_HOME` o diretório do runtime instalado (`core.mjs:10-11`, respeita
`AGENT_TEAM_HOME`):

1. **Read**: bloqueia se o alvo é exatamente `KEY_FILE`. Read em outros arquivos do runtime instalado e em
   `.team/state.json` continua liberado (CA-03.4).
2. **Grep/Glob** (recursivos por natureza): bloqueia se, para algum alvo,
   `isSameOrAncestor(alvo, KEY_FILE) || isInside(alvo, TEAM_HOME) || alvo === TEAM_HOME`.
   Isso cobre o arquivo da chave, `~/.claude/team`, um subdiretório dele, `~/.claude`, `~`, e a raiz do
   volume — **qualquer ancestral** (CA-03.3).
   Motivo: `busca cujo alvo alcança a chave de assinatura das aprovações não é permitida; restrinja o alvo ao diretório do projeto`.
3. **Qualquer outro alvo** — inclusive o projeto inteiro, com qualquer padrão: liberado (CA-03.1, CA-03.2).
   O texto do padrão deixa de ser inspecionado em qualquer situação.

### Shell (RF-07, Q-05)
O bloqueio por literal em `shellPathReason` **continua conservador** (decisão Q-05 do G1): distinguir leitura
de escrita em linha de comando por regex é frágil. Só as mensagens mudam, para indicar a alternativa
(CA-03.5):

- `approval.key` → `a chave de assinatura das aprovações não pode ser acessada. Para pesquisar o código, use as ferramentas Grep/Glob com o alvo dentro do projeto.`
- `.claude/team` → mensagem atual + `Para ler ou pesquisar o código do runtime, use Read, Grep ou Glob (o alvo não pode ser o diretório do runtime instalado).`
- `.team/(state|config).json` → mensagem atual (já cita Read).

Todos os bloqueios de shell de `guard.test.mjs` continuam valendo (CA-03.6).

## Consequências
- Positivas: fecha o B-04 (a chave deixa de ser alcançável por busca em ancestral) e elimina o B-03 inteiro
  para Grep/Glob, que é onde o atrito dói; a comparação passa a ser estrutural, sem regex de caminho.
- Negativas: uma busca legítima com alvo em `~` ou `~/.claude` (por exemplo, procurar a própria config do
  Claude Code) passa a ser bloqueada. É o preço do CA-03.3; a saída é restringir o alvo.
- Riscos / o que **não** está coberto (vai para "Limites" no README):
  - link simbólico ou junction apontando para dentro da árvore da chave não é detectado (comparação lexical);
  - o bloqueio por shell continua causando falso positivo quando o comando só cita o literal;
  - se uma ferramenta nova (MCP) fizer busca sem passar pelo matcher do hook, não é avaliada (B-15, v1.2).
- O que fica mais difícil: liberar buscas por shell no futuro exigirá extrair o alvo do comando, ou seja, o
  tokenizador do ADR-009 aplicado a `grep`/`rg`/`Select-String`.
