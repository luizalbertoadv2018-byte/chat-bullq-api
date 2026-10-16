import {
  rememberSigningLink,
  withPendingSigningLink,
} from './signing-link-registry';

const LINK = 'https://app.zapsign.com.br/verificar/abc123';

describe('signing-link-registry', () => {
  afterEach(() => jest.useRealTimers());

  it('cola o link quando o agente esqueceu', () => {
    rememberSigningLink('conv_1', LINK);
    expect(withPendingSigningLink('conv_1', 'Enviei o link da ficha!')).toBe(
      `Enviei o link da ficha!\n\n${LINK}`,
    );
  });

  it('não duplica quando o agente já colou o link', () => {
    rememberSigningLink('conv_2', LINK);
    const text = `Segue o link: ${LINK}`;
    expect(withPendingSigningLink('conv_2', text)).toBe(text);
  });

  it('consome o link: a resposta seguinte sai sem ele', () => {
    rememberSigningLink('conv_3', LINK);
    withPendingSigningLink('conv_3', 'primeira');
    expect(withPendingSigningLink('conv_3', 'segunda')).toBe('segunda');
  });

  it('não mexe em outras conversas', () => {
    rememberSigningLink('conv_4', LINK);
    expect(withPendingSigningLink('conv_outra', 'oi')).toBe('oi');
  });

  it('link vencido (mais de 15 min) não é colado', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-16T17:00:00Z'));
    rememberSigningLink('conv_5', LINK);
    jest.setSystemTime(new Date('2026-10-16T17:16:00Z'));
    expect(withPendingSigningLink('conv_5', 'oi')).toBe('oi');
  });
});
