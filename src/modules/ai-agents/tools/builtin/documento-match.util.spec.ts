import { matchDocumento } from './documento-match.util';

const docs = [
  'RG ou CNH (frente e verso)',
  'Comprovante de residência',
  'Prints do bloqueio e da mensagem recebida',
  'Identificação da conta (usuário, número, e-mail ou agência e conta)',
  'Protocolos e respostas do recurso ou atendimento',
  'Comprovante do prejuízo ou do saldo retido (extrato, faturamento)',
].map((name) => ({ name }));

const match = (alvo: string) => matchDocumento(docs, alvo)?.name;

describe('matchDocumento', () => {
  it('casa singular com plural (o caso que falhava em produção)', () => {
    expect(match('print do bloqueio')).toBe(
      'Prints do bloqueio e da mensagem recebida',
    );
  });

  it('casa por sigla e por sinônimo', () => {
    expect(match('RG')).toBe('RG ou CNH (frente e verso)');
    expect(match('CNH')).toBe('RG ou CNH (frente e verso)');
    expect(match('identidade')).toBe('RG ou CNH (frente e verso)');
    expect(match('captura de tela do bloqueio')).toBe(
      'Prints do bloqueio e da mensagem recebida',
    );
  });

  it('distingue os dois comprovantes', () => {
    expect(match('comprovante de residência')).toBe('Comprovante de residência');
    expect(match('comprovante de endereço')).toBe('Comprovante de residência');
    expect(match('comprovante do prejuízo')).toBe(
      'Comprovante do prejuízo ou do saldo retido (extrato, faturamento)',
    );
  });

  it('não inventa correspondência', () => {
    expect(match('certidão de casamento')).toBeUndefined();
    expect(match('')).toBeUndefined();
  });
});
