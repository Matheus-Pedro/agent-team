// Varredura de citação de linha de comando (ADR-009). Serve a uma pergunta só:
// o comando tem metacaractere **com poder de shell**, ou o caractere está dentro
// de aspas e é literal?
//
// Não é um parser de shell. Erro de parsing sempre resulta em "tem metacaractere",
// ou seja, o comando sai da lista branca do CLI e cai nas regras de negação
// seguintes — fail-closed por construção.

// Fora de aspas: o conjunto da v1.0.
const OUTSIDE_META_RE = /[;&|<>`\r\n]|\$\(/;
// Dentro de "...": PowerShell e POSIX expandem subexpressão; `;`, `&`, `|`, `<`, `>` são literais.
const DQUOTE_META_RE = /[`]|\$\(|\$\{/;

/**
 * Divide o comando em segmentos por contexto de citação, em uma passada.
 * @returns {Array<{text: string, quote: null|"'"|'"', closed: boolean}>}
 *   `closed: false` só aparece no último segmento, quando a aspa não foi fechada.
 */
export function scanQuoting(command) {
  const s = String(command ?? '');
  const segments = [];
  let quote = null;
  let buf = '';
  const flush = (closed) => {
    if (buf !== '') segments.push({ text: buf, quote, closed });
    buf = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // Só `\"` é escape. `\` solto continua literal — é separador de caminho no
    // Windows, e tratá-lo como escape genérico esconderia `\&&` de verdade.
    if (c === '\\' && s[i + 1] === '"' && quote !== "'") {
      buf += '\\"';
      i++;
      continue;
    }
    if (quote === null && (c === '"' || c === "'")) {
      flush(true);
      quote = c;
      continue;
    }
    if (quote !== null && c === quote) {
      flush(true);
      quote = null;
      continue;
    }
    buf += c;
  }
  flush(quote === null);
  if (quote !== null && buf === '') segments.push({ text: '', quote, closed: false });
  return segments;
}

/**
 * Primeiro metacaractere com poder de shell, considerando o contexto de citação.
 * @returns {string|null} o trecho ofensivo (para a mensagem), ou `null` quando não há.
 */
export function unquotedMeta(command) {
  for (const seg of scanQuoting(command)) {
    if (seg.quote && !seg.closed) return 'aspas não fechadas';
    if (seg.quote === "'") continue; // literal em POSIX e em PowerShell
    const m = (seg.quote === '"' ? DQUOTE_META_RE : OUTSIDE_META_RE).exec(seg.text);
    if (m) return m[0] === '\r' ? '\\r' : m[0] === '\n' ? '\\n' : m[0];
  }
  return null;
}
