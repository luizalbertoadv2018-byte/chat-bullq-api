/**
 * Busca por texto dentro das mensagens (estilo WhatsApp): normalização que
 * ignora maiúsculas e acentos, e o recorte do trecho mostrado na lista.
 */

/** Mínimo de caracteres para procurar dentro das mensagens. */
export const MESSAGE_SEARCH_MIN_LENGTH = 2;

const SNIPPET_BEFORE = 30;
const SNIPPET_LENGTH = 140;

/** Minúsculas e sem acento: "Indenização" e "indenizacao" casam. */
export function normalizeSearch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Letras que aceitam acento em português (e o ñ dos nomes hispânicos).
const ACCENT_CLASSES: Record<string, string> = {
  a: '[aáàâãä]',
  e: '[eéèêë]',
  i: '[iíìîï]',
  o: '[oóòôõö]',
  u: '[uúùûü]',
  c: '[cç]',
  n: '[nñ]',
};

/**
 * Regex (sintaxe do Postgres, para usar com `~*`) que acha o termo com ou
 * sem acento. Bem mais rápido que tirar o acento de cada mensagem com
 * translate() na hora da busca. O resto do termo é tratado como literal.
 */
export function buildAccentRegex(term: string): string {
  return [...normalizeSearch(term.trim())]
    .map((ch) => ACCENT_CLASSES[ch] ?? ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('');
}

/**
 * Recorta o texto em volta da primeira ocorrência do termo, para caber numa
 * linha da lista. Sem ocorrência (não deveria acontecer), devolve o começo.
 */
export function buildSnippet(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = normalizeSearch(flat).indexOf(normalizeSearch(term.trim()));
  const start = at > SNIPPET_BEFORE ? at - SNIPPET_BEFORE : 0;
  const slice = flat.slice(start, start + SNIPPET_LENGTH);
  return (
    (start > 0 ? '…' : '') +
    slice +
    (start + SNIPPET_LENGTH < flat.length ? '…' : '')
  );
}

/** Escolhe, entre texto e legenda, o campo que de fato contém o termo. */
export function pickMatchedText(
  term: string,
  text?: string | null,
  caption?: string | null,
): string {
  const needle = normalizeSearch(term.trim());
  if (text && normalizeSearch(text).includes(needle)) return text;
  if (caption && normalizeSearch(caption).includes(needle)) return caption;
  return text || caption || '';
}
