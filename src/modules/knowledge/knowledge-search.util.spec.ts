import {
  CHUNK_TARGET,
  MAX_TOTAL_CHARS,
  countOccurrences,
  rankKnowledgeChunks,
  splitIntoChunks,
} from './knowledge-search.util';

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => `Parágrafo de enchimento número ${i} sem relação com o tema.`).join('\n\n');

// Guia longo em que a resposta sobre grupo familiar fica bem depois dos
// primeiros 700 caracteres (o caso que falhava em produção).
const guiaLongo = {
  title: 'Guia Prático: Como Obter o Benefício do BPC/LOAS',
  content: [
    '# Introdução',
    filler(12),
    '## Grupo familiar',
    'Entram no cálculo da renda per capita o requerente, o cônjuge ou companheiro, os pais, os irmãos solteiros e os filhos e enteados solteiros que morem na mesma casa.',
    '## Perícia',
    'A perícia médica do INSS avalia o impedimento de longo prazo.',
  ].join('\n\n'),
};

const dadosEscritorio = {
  title: 'DADOS DO ESCRITÓRIO',
  content: 'Alberto Martins Advocacia, OAB/GO 59.239, em Anicuns/GO.',
};

describe('splitIntoChunks', () => {
  it('nenhum trecho passa do tamanho-alvo', () => {
    const chunks = splitIntoChunks(guiaLongo.content + '\n\n' + 'x'.repeat(3000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_TARGET);
  });

  it('título Markdown abre trecho novo e fica junto da sua seção', () => {
    const chunks = splitIntoChunks(guiaLongo.content);
    const grupo = chunks.find((c) => c.includes('## Grupo familiar'));
    expect(grupo).toBeDefined();
    expect(grupo!.startsWith('## Grupo familiar')).toBe(true);
    expect(grupo).toContain('irmãos solteiros');
  });

  it('documento curto vira um trecho só', () => {
    expect(splitIntoChunks(dadosEscritorio.content)).toEqual([dadosEscritorio.content]);
  });
});

describe('rankKnowledgeChunks', () => {
  it('acha a resposta no meio de um guia longo', () => {
    const hits = rankKnowledgeChunks([guiaLongo, dadosEscritorio], 'quem entra no grupo familiar? meus irmãos contam?');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe(guiaLongo.title);
    expect(hits[0].content).toContain('irmãos solteiros');
    expect(hits[0].content).not.toContain('enchimento número 0');
  });

  it('não devolve documento que não casa', () => {
    const hits = rankKnowledgeChunks([guiaLongo, dadosEscritorio], 'qual a OAB do escritório?');
    expect(hits.map((h) => h.title)).toEqual([dadosEscritorio.title]);
  });

  it('pergunta sem termos úteis não devolve nada', () => {
    expect(rankKnowledgeChunks([guiaLongo], 'e o que?')).toEqual([]);
  });

  it('respeita o teto total de caracteres', () => {
    const muitos = Array.from({ length: 10 }, (_, i) => ({
      title: `Doc ${i}`,
      content: Array.from({ length: 5 }, () => 'renda per capita ' + 'y '.repeat(400)).join('\n\n'),
    }));
    const hits = rankKnowledgeChunks(muitos, 'renda per capita', 10);
    const total = hits.reduce((n, h) => n + h.content.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_CHARS + 20);
  });
});

describe('countOccurrences', () => {
  it('conta ocorrências coladas', () => {
    expect(countOccurrences('bpc bpc bpc', 'bpc')).toBe(3);
  });

  it('não casa pedaço de palavra', () => {
    expect(countOccurrences('bpcloas', 'bpc')).toBe(0);
  });
});
