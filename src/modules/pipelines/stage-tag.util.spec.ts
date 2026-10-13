import {
  applyStageTag,
  isStageTagName,
  normalizeTagName,
} from './stage-tag.util';

describe('stage-tag.util', () => {
  it('normaliza acento, hífen e caixa', () => {
    expect(normalizeTagName('Recepção')).toBe('recepcao');
    expect(normalizeTagName('bloqueio-rede-social')).toBe('bloqueio rede social');
    expect(normalizeTagName('  Assinatura   Pendente ')).toBe('assinatura pendente');
  });

  it('reconhece etiqueta de etapa e deixa as de tema em paz', () => {
    expect(isStageTagName('analisando-proposta')).toBe(true);
    expect(isStageTagName('Contrato Assinado')).toBe(true);
    expect(isStageTagName('bloqueio rede social')).toBe(false);
    expect(isStageTagName('lead-quente')).toBe(false);
  });

  it('troca as etiquetas de etapa antigas pela da etapa atual', async () => {
    const tags = [
      { id: 't1', name: 'recepcao' },
      { id: 't2', name: 'recepção' },
      { id: 't3', name: 'analisando proposta' },
      { id: 't4', name: 'bloqueio rede social' },
      { id: 't5', name: 'contrato assinado' },
    ];
    const db: any = {
      tag: { findMany: jest.fn().mockResolvedValue(tags), create: jest.fn() },
      conversationSituacao: {
        findMany: jest.fn().mockResolvedValue([{ name: 'Contrato Assinado' }]),
      },
      conversationTag: {
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
        create: jest.fn().mockResolvedValue({}),
      },
    };

    await applyStageTag(db, 'org', 'conv', 'Contrato Assinado');

    expect(db.tag.create).not.toHaveBeenCalled();
    expect(db.conversationTag.deleteMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv', tagId: { in: ['t1', 't2', 't3'] } },
    });
    expect(db.conversationTag.create).toHaveBeenCalledWith({
      data: { conversationId: 'conv', tagId: 't5' },
    });
  });

  it('cria a etiqueta da etapa quando ela ainda não existe', async () => {
    const db: any = {
      tag: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'novo', name: 'proposta enviada' }),
      },
      conversationSituacao: { findMany: jest.fn().mockResolvedValue([]) },
      conversationTag: { deleteMany: jest.fn(), create: jest.fn().mockResolvedValue({}) },
    };

    await applyStageTag(db, 'org', 'conv', 'Proposta Enviada');

    expect(db.tag.create).toHaveBeenCalledWith({
      data: { organizationId: 'org', name: 'proposta enviada' },
      select: { id: true, name: true },
    });
    expect(db.conversationTag.deleteMany).not.toHaveBeenCalled();
  });
});
