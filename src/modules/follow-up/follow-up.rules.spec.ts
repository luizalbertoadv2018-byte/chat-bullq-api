import { isWithinBusinessHours, nextBusinessInstant } from './business-hours.util';
import {
  buildFollowUpNote,
  classifyStage,
  DEFAULT_FOLLOW_UP_HOURS,
  delayForStep,
  docsToChase,
  isBasicDocument,
  isOptOut,
  resolveFollowUpConfig,
} from './follow-up.rules';

const TZ = 'America/Sao_Paulo';
const day = { enabled: true, windows: [['08:00', '20:00']] as Array<[string, string]> };
const HOURS = {
  monday: day,
  tuesday: day,
  wednesday: day,
  thursday: day,
  friday: day,
  saturday: day,
  sunday: { enabled: false },
};

describe('horário comercial', () => {
  it('mantém o instante quando já está dentro da janela', () => {
    const d = new Date('2026-10-13T15:00:00Z'); // terça 12:00 em SP
    expect(isWithinBusinessHours(HOURS, TZ, d)).toBe(true);
    expect(nextBusinessInstant(HOURS, TZ, d)).toEqual(d);
  });

  it('empurra a noite para as 8h do dia seguinte', () => {
    const d = new Date('2026-10-14T01:30:00Z'); // terça 22:30 em SP
    expect(nextBusinessInstant(HOURS, TZ, d).toISOString()).toBe(
      '2026-10-14T11:00:00.000Z', // quarta 08:00 em SP
    );
  });

  it('pula o domingo', () => {
    const d = new Date('2026-10-18T15:00:00Z'); // domingo 12:00 em SP
    expect(nextBusinessInstant(HOURS, TZ, d).toISOString()).toBe(
      '2026-10-19T11:00:00.000Z', // segunda 08:00 em SP
    );
  });

  it('sem configuração vale 24/7', () => {
    const d = new Date('2026-10-18T05:00:00Z');
    expect(nextBusinessInstant(null, TZ, d)).toEqual(d);
  });
});

describe('horário próprio do follow-up (seg a sex, 8h às 19h)', () => {
  const cfg = resolveFollowUpConfig(undefined, null, { force: true });

  it('é o padrão quando a organização não define outro', () => {
    expect(cfg.businessHours).toBe(DEFAULT_FOLLOW_UP_HOURS);
  });

  it('não envia às 19h30 de um dia útil', () => {
    const d = new Date('2026-10-13T22:30:00Z'); // terça 19:30 em SP
    expect(isWithinBusinessHours(cfg.businessHours, TZ, d)).toBe(false);
    expect(nextBusinessInstant(cfg.businessHours, TZ, d).toISOString()).toBe(
      '2026-10-14T11:00:00.000Z', // quarta 08:00
    );
  });

  it('sexta à noite e sábado vão para segunda às 8h', () => {
    const friday = new Date('2026-10-16T23:00:00Z'); // sexta 20:00 em SP
    const saturday = new Date('2026-10-17T15:00:00Z'); // sábado 12:00 em SP
    for (const d of [friday, saturday]) {
      expect(nextBusinessInstant(cfg.businessHours, TZ, d).toISOString()).toBe(
        '2026-10-19T11:00:00.000Z', // segunda 08:00
      );
    }
  });

  it('envia às 18h59 e não às 19h00', () => {
    expect(
      isWithinBusinessHours(cfg.businessHours, TZ, new Date('2026-10-13T21:59:00Z')),
    ).toBe(true);
    expect(
      isWithinBusinessHours(cfg.businessHours, TZ, new Date('2026-10-13T22:00:00Z')),
    ).toBe(false);
  });
});

describe('regras do follow-up', () => {
  it('classifica as etapas do funil', () => {
    expect(classifyStage('Proposta Enviada')).toBe('pre-sign');
    expect(classifyStage('Em Análise')).toBe('pre-sign');
    expect(classifyStage('Contrato Assinado')).toBe('post-sign');
    expect(classifyStage('Desqualificado')).toBe('none');
    expect(classifyStage('Sem Retorno')).toBe('none');
    expect(classifyStage('Ação Ajuizada')).toBe('none');
    expect(classifyStage(null)).toBe('none');
  });

  it('só liga quando a org habilitou E o agente está na lista', () => {
    const settings = { enabled: true, agents: { rafael: { cadenceHours: [24, 96] } } };
    expect(resolveFollowUpConfig(settings, 'rafael', {}).enabled).toBe(true);
    expect(resolveFollowUpConfig(settings, 'outro', {}).enabled).toBe(false);
    expect(resolveFollowUpConfig({ agents: settings.agents }, 'rafael', {}).enabled).toBe(false);
    expect(resolveFollowUpConfig(undefined, 'rafael', {}).enabled).toBe(false);
    expect(resolveFollowUpConfig(undefined, 'rafael', { force: true }).enabled).toBe(true);
  });

  it('espera 1 dia, depois mais 3, depois o prazo de encerramento', () => {
    const cfg = resolveFollowUpConfig(
      { enabled: true, agents: { a: { cadenceHours: [24, 96] } } },
      'a',
      {},
    );
    expect(delayForStep(0, cfg)).toBe(24 * 60);
    expect(delayForStep(1, cfg)).toBe(72 * 60);
    expect(delayForStep(2, cfg)).toBe(72 * 60); // exhaustAfterHours padrão
  });

  it('aceita cadência de teste em minutos por conversa', () => {
    const cfg = resolveFollowUpConfig(undefined, null, {
      force: true,
      cadenceMinutes: [2, 5],
      exhaustAfterMinutes: 3,
    });
    expect(cfg.testMode).toBe(true);
    expect([delayForStep(0, cfg), delayForStep(1, cfg), delayForStep(2, cfg)]).toEqual([2, 3, 3]);
  });

  it('reconhece quem pediu para parar', () => {
    expect(isOptOut('Não tenho interesse, obrigado')).toBe(true);
    expect(isOptOut('ja resolvi aqui')).toBe(true);
    expect(isOptOut('para de me mandar mensagem')).toBe(true);
    expect(isOptOut('vou ver e te falo')).toBe(false);
    expect(isOptOut('Não tenho comprovante')).toBe(false);
  });

  it('separa os documentos básicos dos demais', () => {
    expect(isBasicDocument('RG ou CNH (frente e verso)')).toBe(true);
    expect(isBasicDocument('Comprovante de residência')).toBe(true);
    expect(isBasicDocument('Prints do bloqueio e da mensagem recebida')).toBe(true);
    expect(isBasicDocument('Comprovante do prejuízo ou do saldo retido')).toBe(false);
  });

  it('monta a instrução da última retomada com despedida', () => {
    const note = buildFollowUpNote({
      stageName: 'Ficha Enviada',
      kind: 'pre-sign',
      silenceMinutes: 96 * 60,
      attempt: 2,
      maxAttempts: 2,
    });
    expect(note).toContain('há 4 dias');
    expect(note).toContain('retomada 2 de 2');
    expect(note).toContain('link da ficha');
    expect(note).toContain('última retomada');
  });

  it('depois da assinatura só cobra o documento que falta', () => {
    const note = buildFollowUpNote({
      stageName: 'Contrato Assinado',
      kind: 'post-sign',
      silenceMinutes: 24 * 60,
      attempt: 2,
      maxAttempts: 2,
      missingDocs: ['Comprovante de residência'],
    });
    expect(note).toContain('Comprovante de residência');
    expect(note).not.toContain('última retomada');
  });
});

describe('docsToChase', () => {
  const pos = [
    { id: 'a', name: 'RG ou CNH (frente e verso)' },
    { id: 'b', name: 'Comprovante de residência' },
    { id: 'c', name: 'Extrato do benefício' },
  ];
  const gratuidade = [
    { id: 'g1', name: 'Declarações de Imposto de Renda' },
    { id: 'g2', name: 'Extratos bancários dos últimos 3 meses' },
    { id: 'g3', name: 'Faturas dos cartões de crédito' },
  ];

  it('funil com documentos básicos: cobra só os básicos que faltam', () => {
    expect(docsToChase(pos, { a: { recebido: true } })).toEqual(['Comprovante de residência']);
  });

  it('funil só de coleta (sem básico): cobra todos os que faltam', () => {
    expect(docsToChase(gratuidade, { g2: { recebido: true } })).toEqual([
      'Declarações de Imposto de Renda',
      'Faturas dos cartões de crédito',
    ]);
  });

  it('tudo recebido: nada a cobrar', () => {
    expect(docsToChase(gratuidade, { g1: 1, g2: 1, g3: 1 })).toEqual([]);
  });
});
