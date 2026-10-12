/**
 * Casa o nome que a IA usou para um documento ("print do bloqueio") com o
 * nome cadastrado no checklist ("Prints do bloqueio e da mensagem recebida").
 * A comparação por "contém" falhava por um plural, e o print do cliente
 * ficava sem ser marcado como recebido.
 */

const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'e', 'ou', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na',
  'com', 'para', 'por', 'um', 'uma', 'meu', 'minha', 'seu', 'sua',
]);

// Jeitos comuns de chamar o mesmo documento.
const SYNONYMS: Record<string, string> = {
  identidade: 'rg',
  habilitacao: 'cnh',
  endereco: 'residencia',
  captura: 'print',
  screenshot: 'print',
  tela: 'print',
};

function tokens(value: string): string[] {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t))
    .map((t) => SYNONYMS[t] ?? t);
}

/**
 * Devolve o item cujo nome melhor corresponde a `alvo`, ou undefined.
 * Vence quem contém todas as palavras do alvo (o nome mais específico em caso
 * de empate); sem isso, quem cobre pelo menos metade delas.
 */
export function matchDocumento<T extends { name: string }>(
  docs: T[],
  alvo: string,
): T | undefined {
  const wanted = [...new Set(tokens(alvo))];
  if (wanted.length === 0) return undefined;

  let best: { doc: T; score: number; size: number } | undefined;
  for (const doc of docs) {
    const have = new Set(tokens(doc.name));
    const hits = wanted.filter((t) => have.has(t)).length;
    if (hits === 0) continue;
    const score = hits / wanted.length;
    if (
      !best ||
      score > best.score ||
      (score === best.score && have.size < best.size)
    ) {
      best = { doc, score, size: have.size };
    }
  }
  return best && best.score >= 0.5 ? best.doc : undefined;
}
