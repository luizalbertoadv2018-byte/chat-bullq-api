import {
  buildAccentRegex,
  buildSnippet,
  normalizeSearch,
  pickMatchedText,
} from './message-search.util';

describe('message-search.util', () => {
  it('normaliza ignorando maiúsculas e acentos', () => {
    expect(normalizeSearch('Indenização')).toBe('indenizacao');
    expect(normalizeSearch('AÇÃO')).toBe('acao');
  });

  it('monta regex que aceita o termo com ou sem acento', () => {
    const re = new RegExp(buildAccentRegex('Acao'), 'i');
    expect(re.test('entrar com a AÇÃO')).toBe(true);
    expect(re.test('acao')).toBe(true);
    expect(re.test('acordo')).toBe(false);
  });

  it('trata pontuação do termo como texto literal', () => {
    const re = new RegExp(buildAccentRegex('r$ 1.000 (pix)'), 'i');
    expect(re.test('paguei R$ 1.000 (pix) ontem')).toBe(true);
    expect(re.test('paguei R$ 1x000 (pix)')).toBe(false);
  });

  it('devolve o texto inteiro quando ele é curto', () => {
    expect(buildSnippet('Assinei o contrato ontem', 'contrato')).toBe(
      'Assinei o contrato ontem',
    );
  });

  it('recorta em volta do termo em textos longos', () => {
    const text = `${'a'.repeat(200)} minha conta foi bloqueada ${'b'.repeat(200)}`;
    const snippet = buildSnippet(text, 'Bloqueada');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('bloqueada');
    expect(snippet.length).toBeLessThanOrEqual(142);
  });

  it('acha o termo sem acento num texto acentuado', () => {
    expect(buildSnippet('Quero a indenização', 'indenizacao')).toBe(
      'Quero a indenização',
    );
  });

  it('prefere o campo que contém o termo', () => {
    expect(pickMatchedText('print', 'segue', 'print do bloqueio')).toBe(
      'print do bloqueio',
    );
    expect(pickMatchedText('segue', 'segue', 'print')).toBe('segue');
  });
});
