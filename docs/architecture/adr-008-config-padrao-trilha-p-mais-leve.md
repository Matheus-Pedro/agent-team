# ADR-008 — Config padrão: trilha P sem G1 e G2
Status: Aceito no G2 em 2026-09-17 · Data: 2026-09-17 · Work item: W-001-evolucao-v1-1

## Contexto
US-06 (NICE_TO_HAVE), RF-11, B-08, decisão Q-04 do G1. `defaultConfig()` (`core.mjs:140-147`) liga os quatro
gates configuráveis nas três trilhas, então um bugfix na trilha P pede 4 aprovações do usuário mais o PROD.
Isso cria atrito em tarefa pequena e incentiva o usuário a fugir do fluxo (desligar `enforce` ou não usar o
time). O README (`:119`) hoje ensina o ajuste manual.

O G1 aceitou a recomendação: trilha P nasce com G1 e G2 desligados; G3 (merge, onde o usuário vê o diff) e G4
(deploy) continuam ligados; PROD é sempre obrigatório e não configurável.

## Opções consideradas
1. **Manter tudo ligado e documentar o ajuste manual.** Prós: nenhum risco novo. Contras: mantém o atrito
   observado e depende de o usuário editar a config antes do primeiro bugfix.
2. **Desligar G1 e G2 na trilha P no `defaultConfig`.** Prós: resolve o atrito de saída; G3 e G4/PROD
   continuam protegendo o que importa (o que entra na principal e o que vai para produção). Contras: aumenta o
   incentivo a classificar trabalho como P para pular gates.
3. **Desligar G1, G2 e G3 na trilha P.** Contras: deixaria o merge na principal sem revisão humana; é a única
   proteção que não pode cair.
4. **Gates por tamanho de diff, calculados em tempo real.** Contras: funcionalidade nova, regra implícita e
   difícil de auditar. Fora do escopo desta versão.

## Decisão
Opção 2:

```js
gates: {
  P: { G1: false, G2: false, G3: true, G4: true },
  M: { G1: true, G2: true, G3: true, G4: true },
  G: { G1: true, G2: true, G3: true, G4: true },
}
```

`TRANSITIONS` já suporta isso sem mudança: `PLANNING → ARCHITECTING` com `off('G1')` e
`ARCHITECTING → IMPLEMENTING` com `off('G2')` (`core.mjs:52-69`). `gateEnabled` continua devolvendo `true`
para PROD sempre (`:352`), então CA-06.4 é regressão pura.

`team init` passa a imprimir uma linha com os gates ligados por trilha (CA-06.3) — formato em
[`contracts.md` §2](./contracts.md) — para que a escolha fique visível no momento em que o projeto nasce, e não
escondida no arquivo.

Configs já existentes não mudam (CA-06.2), por força da regra 6 do ADR-007 (`gates` do usuário substitui o
default trilha por trilha).

O texto do README sobre configuração precisa deixar claro o mecanismo de defesa contra o risco: a regra "na
dúvida, trilha maior" do Orchestrator, e o G3, em que o usuário vê o diff antes do merge.

## Consequências
- Positivas: bugfix passa a ter 2 aprovações (G3 e G4) + PROD quando houver deploy, em vez de 5; menos
  incentivo a contornar o fluxo.
- Negativas: em trilha P, requisitos e arquitetura deixam de ter aprovação formal — o documento de requisitos
  continua sendo escrito, só não passa por gate. Se o Orchestrator classificar errado um trabalho grande como
  P, perde-se a chance de corrigir cedo.
- Riscos: classificação incorreta de trilha. Mitigação: regra "na dúvida, trilha maior" no SKILL.md, G3
  obrigatório e a saída do `team init`/`team status` mostrando os gates ligados.
- É NICE_TO_HAVE: se o ciclo apertar, esta é a primeira tarefa a sair, sem impacto em nenhuma outra (só toca
  `defaultConfig` e a saída do `team init`).
