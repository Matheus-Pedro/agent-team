# ADR-005 — Fail-closed escopado: erro interno do guard bloqueia só dentro de projeto com time ativo
Status: Aceito no G2 em 2026-09-17 · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

## Contexto
US-05, RF-10, B-06. `hooks/guard.mjs:16-22` captura qualquer exceção de `evaluateToolCall`, escreve em stderr e
sai com 0 — ou seja, **um bug nas regras desliga a proteção sem aviso**. Esta versão altera justamente essas
regras (ADR-001, ADR-003, ADR-009), então a probabilidade de exceção é a mais alta de toda a história do
projeto. Por outro lado, bloquear tudo em caso de erro travaria também sessões do usuário em projetos que não
têm nada a ver com o time (RNF-04: "fora dele, nunca bloquear").

O problema fino: a decisão de bloquear depende de saber se há time ativo, e a exceção pode vir exatamente do
código que descobre isso.

## Opções consideradas
1. **Manter fail-open.** Prós: nunca trava ninguém. Contras: é o B-06; a garantia do produto pode estar
   desligada sem ninguém perceber.
2. **Fail-closed global.** Prós: máxima segurança. Contras: um bug no guard instalado quebra todas as sessões
   do usuário, em qualquer diretório — inclusive as que ele usaria para consertar. Inaceitável.
3. **Fail-closed escopado, com o contexto calculado antes e separadamente da avaliação.** Prós: atende
   CA-05.1 a CA-05.4; o cálculo do contexto é mínimo (`fs.statSync` + `JSON.parse`) e tem o seu próprio
   `try/catch`. Contras: duas fases, duas capturas; se o contexto também falhar, precisa de uma regra.
4. **Bloquear e registrar no log de auditoria.** Contras: escrever no `.team/logs` no caminho de erro pode
   lançar outra exceção e custa I/O em todo erro; e o guard não é o dono do log (quem escreve é o runtime pelo
   CLI/hook de prompt). Rejeitado: o RNF-08 pede stderr para erro interno, e é só isso que fazemos.

## Decisão
Opção 3. Sequência em `hooks/guard.mjs`:

1. `JSON.parse(stdin)` falha → `exit 0` (CA-05.3: sem entrada legível não se sabe se há time ativo).
2. `ctx = enforcementContext(input)` — função nova, exportada por `guard-rules.mjs`, dentro do seu próprio
   `try/catch`:
   - `root = findTeamRoot(cwd)`; sem root → `{ root: null, enforcing: false }`;
   - `config = loadConfig(root)`; se lançar (config corrompida) → `enforcing: true` (coerente com
     `evaluateToolCall`, que já aplica `defaultConfig()` nesse caso);
   - `enforcing = config.enforce !== false` (CA-05.4);
   - se a própria `enforcementContext` lançar → `{ root: null, enforcing: false }` + stderr. Não se sabe se há
     time ativo, então não se trava a sessão.
3. `result = evaluateToolCall(input)`. Em exceção:
   - `ctx.enforcing === true` → stderr com o bloqueio e **`exit 2`**;
   - senão → stderr `[agent-team guard] erro interno ignorado: <msg>` e `exit 0` (CA-05.2).

Mensagem de bloqueio (CA-05.1, RNF-05):

```
[agent-team] BLOQUEADO: erro interno do guard ao avaliar <tool_name> (<err.name>: <err.message, até 300 caracteres>).
Por segurança a ação foi bloqueada. Pare, informe o usuário e reporte o erro; se precisar desbloquear o
projeto, só o usuário pode editar .team/config.json (enforce: false).
Não tente contornar este bloqueio com outro comando. Pare e reporte ao Orchestrator/usuário.
```

Nunca inclui `err.stack` (pode ter caminhos longos e ruído) e nunca inclui conteúdo de arquivo — a chave não
passa por esse caminho, e a mensagem é montada só a partir de `err.name`/`err.message` e do nome da ferramenta
(RNF-04).

## Consequências
- Positivas: um bug nas regras passa a ser visível e seguro; o erro fica rastreável em stderr (RNF-08); fora de
  projeto com time, nada muda.
- Negativas: se a v1.1 instalada tiver um bug determinístico, o projeto para até o usuário intervir. É o risco
  aceito em troca da garantia — e é o motivo de o smoke do RNF-06 (b) ser obrigatório antes de instalar no
  diretório real.
- Riscos: o `exit 2` do guard é interpretado pelo harness como negação da ferramenta; se o erro ocorrer numa
  ferramenta muito usada (Read, por exemplo), o agente fica sem poder trabalhar. A mensagem já diz qual é a
  saída (o usuário desliga `enforce`), o que precisa aparecer no README.
- O que fica mais difícil: qualquer regra nova precisa ser defensiva por conta própria — o "vai passar mesmo se
  eu errar" deixou de existir.
