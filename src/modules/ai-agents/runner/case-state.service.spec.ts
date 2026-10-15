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

  it('cliente assinado: mostra o dossiê colhido e o que falta perguntar', async () => {
    const svc = build({ stage: { name: 'Contrato Assinado' } });
    const text = await svc.describe({
      ...base,
      contactMetadata: {
        tramitacaoReleased: true,
        dossie: { conta: '@barbearia_jh', dataBloqueio: 'dia 5' },
      },
    });
    expect(text).toContain('conta = "@barbearia_jh"');
    expect(text).toContain('AINDA FALTA perguntar');
    expect(text).toContain('desdeQuando');
    expect(text).not.toContain('dataBloqueio (data aproximada');
  });

  it('dossiê completo: avisa que não há mais o que perguntar', async () => {
    const svc = build({ stage: { name: 'Contrato Assinado' } });
    const text = await svc.describe({
      ...base,
      contactMetadata: {
        tramitacaoReleased: true,
        dossie: { conta: 'a', dataBloqueio: 'b', desdeQuando: 'c', uso: 'd', revisao: 'e', prejuizo: 'f' },
      },
    });
    expect(text).toContain('Dossiê: COMPLETO');
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

  it('botão Gerar contrato: manda fechar com o modelo escolhido, sem triagem', async () => {
    const svc = build(null);
    const text = await svc.describe({
      ...base,
      contactMetadata: {
        fechamentoManual: { templateId: 'tpl_9', templateName: 'Honorários BPC' },
      },
    });
    expect(text).toContain('mandou FECHAR com o modelo "Honorários BPC"');
    expect(text).toContain('templateId tpl_9');
    expect(text).toContain('PROIBIDO refazer a triagem');
  });

  it('botão Gerar contrato: depois da ficha gerada, vale a regra da ficha pendente', async () => {
    const svc = build({ stage: { name: 'Ficha Enviada' } });
    const text = await svc.describe({
      ...base,
      contactMetadata: {
        fechamentoManual: { templateId: 'tpl_9' },
        pendingCadastro: { docToken: 'tok' },
      },
    });
    expect(text).toContain('JÁ GERADA');
    expect(text).not.toContain('mandou FECHAR');
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
