import { CaseStateService } from './case-state.service';

function build(card: any, docs: any[] = []) {
  const prisma: any = {
    card: { findFirst: jest.fn().mockResolvedValue(card) },
    documentoBeneficio: { findMany: jest.fn().mockResolvedValue(docs) },
  };
  return new CaseStateService(prisma);
}

const base = {
  conversationId: 'conv_1',
  organizationId: 'org_1',
  agentPipelineId: 'pipe_1',
  timezone: 'America/Sao_Paulo',
};

describe('CaseStateService', () => {
  it('cliente que já assinou: avisa e proíbe recomeçar', async () => {
    const svc = build({ stage: { name: 'Contrato Assinado' } }, [
      { id: 'd1', name: 'RG ou CNH (frente e verso)' },
      { id: 'd2', name: 'Comprovante de residência' },
    ]);
    const text = await svc.describe({
      ...base,
      contactMetadata: {
        tramitacaoReleased: true,
        tramitacaoReleasedAt: '2026-10-11T05:02:03.000Z',
        documentos: { d1: { recebido: true } },
        clientGroupJid: '123@g.us',
      },
    });
    expect(text).toContain('ASSINADA');
    expect(text).toContain('11/10');
    expect(text).toContain('Etapa no funil: Contrato Assinado');
    expect(text).toContain('RG ou CNH');
    expect(text).not.toContain('Comprovante de residência');
    expect(text).toContain('PROIBIDO refazer a triagem');
  });

  it('ficha pendente: manda não gerar outra', async () => {
    const svc = build({ stage: { name: 'Ficha Enviada' } });
    const text = await svc.describe({
      ...base,
      contactMetadata: { pendingCadastro: { docToken: 'tok' } },
    });
    expect(text).toContain('JÁ GERADA');
    expect(text).toContain('NÃO gere outra ficha');
  });

  it('lead em triagem: só informa a etapa', async () => {
    const svc = build({ stage: { name: 'Em Análise' } });
    const text = await svc.describe({ ...base, contactMetadata: {} });
    expect(text).toContain('ainda não gerada');
    expect(text).not.toContain('REGRAS para este estado');
  });

  it('sem card e sem ficha: não injeta nada', async () => {
    const svc = build(null);
    expect(await svc.describe({ ...base, contactMetadata: {} })).toBeNull();
  });
});
