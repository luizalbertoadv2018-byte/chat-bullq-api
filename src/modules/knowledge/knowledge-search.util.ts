/**
 * Busca na base de conhecimento por trechos, não por documento inteiro.
 *
 * Antes, o runner recebia o documento todo e cortava nos primeiros 700
 * caracteres: em guias longos a resposta ficava fora do que a IA via. Agora
 * cada documento é dividido em trechos (por seção/parágrafo, até
 * CHUNK_TARGET), cada trecho é pontuado contra a pergunta e só os melhores
 * vão para o prompt, agrupados por documento e na ordem original.
 */

/** Tamanho-alvo de um trecho, em caracteres. */
export const CHUNK_TARGET = 900;

/** Teto de caracteres somando todos os trechos devolvidos. */
export const MAX_TOTAL_CHARS = 3600;

export interface KnowledgeSourceDoc {
  title: string;
  content: string;
}

/** Um trecho recuperado da base pra injetar no prompt do agente. */
export interface KnowledgeHit {
  title: string;
  content: string;
  rank: number;
}

interface ScoredChunk {
  docIndex: number;
  chunkIndex: number;
  title: string;
  content: string;
  rank: number;
}

/**
 * Pontua os trechos de todos os documentos contra a pergunta e devolve os
 * `limit` melhores, agrupados por documento (trechos do mesmo documento saem
 * juntos, na ordem em que aparecem no texto, separados por "[...]").
 */
export function rankKnowledgeChunks(
  docs: KnowledgeSourceDoc[],
  query: string,
  limit = 4,
): KnowledgeHit[] {
  const terms = tokenize(query);
  if (!terms.length || !docs.length) return [];

  const scored: ScoredChunk[] = [];
  docs.forEach((doc, docIndex) => {
    const titleN = normalizeForSearch(doc.title);
    let titleScore = 0;
    for (const t of terms) titleScore += countOccurrences(titleN, t) * 5;

    splitIntoChunks(doc.content).forEach((chunk, chunkIndex) => {
      const bodyN = normalizeForSearch(chunk);
      let rank = titleScore;
      let bodyMatched = 0;
      for (const t of terms) {
        const occ = countOccurrences(bodyN, t);
        if (occ > 0) {
          bodyMatched++;
          // Teto por termo: um trecho que repete "bpc" 10 vezes não deve
          // vencer um que casa vários termos diferentes da pergunta.
          rank += Math.min(occ, 3);
        }
      }
      rank += bodyMatched * 2;
      // Trecho sem nenhum termo só entra se for a abertura de um documento
      // cujo título casou (dá o contexto do guia).
      const keep = bodyMatched > 0 || (titleScore > 0 && chunkIndex === 0);
      if (!keep || rank <= 0) return;
      scored.push({ docIndex, chunkIndex, title: doc.title, content: chunk, rank });
    });
  });

  scored.sort((a, b) => b.rank - a.rank || a.docIndex - b.docIndex || a.chunkIndex - b.chunkIndex);

  const picked: ScoredChunk[] = [];
  let total = 0;
  for (const c of scored) {
    if (picked.length >= limit) break;
    if (total + c.content.length > MAX_TOTAL_CHARS && picked.length > 0) continue;
    picked.push(c);
    total += c.content.length;
  }

  // Agrupa por documento, mantendo a ordem de relevância entre documentos e a
  // ordem do texto dentro de cada um.
  const byDoc = new Map<number, ScoredChunk[]>();
  for (const c of picked) {
    const list = byDoc.get(c.docIndex) ?? [];
    list.push(c);
    byDoc.set(c.docIndex, list);
  }
  return [...byDoc.values()].map((chunks) => {
    const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
    return {
      title: ordered[0].title,
      content: ordered.map((c) => c.content).join('\n[...]\n'),
      rank: Math.max(...ordered.map((c) => c.rank)),
    };
  });
}

/**
 * Divide o texto em trechos de até CHUNK_TARGET caracteres. Respeita
 * parágrafos (linha em branco) e começa trecho novo em cada título Markdown,
 * pra seção e seu título ficarem juntos. Parágrafo grande demais é quebrado
 * por linha, depois por frase, e em último caso no tamanho.
 */
export function splitIntoChunks(content: string): string[] {
  const blocks = (content || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const pieces: string[] = [];
  for (const b of blocks) {
    if (b.length <= CHUNK_TARGET) pieces.push(b);
    else pieces.push(...splitOversized(b));
  }

  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    const startsSection = /^#{1,6}\s/.test(p);
    if (cur && (startsSection || cur.length + 2 + p.length > CHUNK_TARGET)) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function splitOversized(block: string): string[] {
  const units = block
    .split('\n')
    .flatMap((line) =>
      line.length <= CHUNK_TARGET ? [line] : line.split(/(?<=[.!?;])\s+/),
    )
    .flatMap((u) => (u.length <= CHUNK_TARGET ? [u] : hardCut(u)))
    .filter((u) => u.trim().length > 0);

  const out: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + 1 + u.length > CHUNK_TARGET) {
      out.push(cur);
      cur = u;
    } else {
      cur = cur ? `${cur}\n${u}` : u;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function hardCut(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_TARGET) {
    out.push(text.slice(i, i + CHUNK_TARGET));
  }
  return out;
}

// ─── helpers de busca (accent- e case-insensitive) ───────────────────

const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'e', 'ou',
  'que', 'com', 'sem', 'por', 'para', 'pra', 'no', 'na', 'nos', 'nas', 'em',
  'ao', 'aos', 'me', 'te', 'se', 'eu', 'voce', 'vc', 'ele', 'ela', 'meu',
  'minha', 'seu', 'sua', 'como', 'qual', 'quais', 'quanto', 'quanta', 'quando',
  'onde', 'e', 'ja', 'nao', 'sim', 'isso', 'esse', 'essa', 'este', 'esta',
  'sobre', 'the', 'of', 'to',
]);

/** minúsculas + sem acento, colapsa espaços. */
export function normalizeForSearch(text: string): string {
  return (text || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Termos significativos da pergunta (normalizados, sem stopwords/curtos). */
export function tokenize(query: string): string[] {
  const norm = normalizeForSearch(query);
  const raw = norm.split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** Conta ocorrências de `term` (por palavra) no texto já normalizado. */
export function countOccurrences(haystackNorm: string, term: string): number {
  if (!term) return 0;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Lookahead no fim pra não consumir o separador: "bpc bpc" conta 2.
  const re = new RegExp(`(^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, 'g');
  let n = 0;
  while (re.exec(haystackNorm) !== null) n++;
  return n;
}
