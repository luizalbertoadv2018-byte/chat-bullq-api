import { RegistrarDadoDoCasoTool } from './registrar-dado-do-caso.tool';

const ctx: any = { contactId: 'c_1', runId: 'r_1' };

function build(metadata: Record<string, any>) {
  const prisma: any = {
    contact: {
      findUnique: jest.fn().mockResolvedValue({ metadata }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  return { tool: new RegistrarDadoDoCasoTool(prisma), prisma };
}

describe('RegistrarDadoDoCasoTool', () => {
  it('grava o campo sem apagar o resto do metadata e lista o que falta', async () => {
    const { tool, prisma } = build({
      tramitacaoReleased: true,
      documentos: { d1: { recebido: true } },
    });
    const res = await tool.execute({ campo: 'conta', valor: '@barbearia_jh' }, ctx);

    const saved = prisma.contact.update.mock.calls[0][0].data.metadata;
    expect(saved.tramitacaoReleased).toBe(true);
    expect(saved.documentos).toEqual({ d1: { recebido: true } });
    expect(saved.dossie.conta).toBe('@barbearia_jh');

    const out = res.output as any;
    expect(out.ok).toBe(true);
    expect(out.completo).toBe(false);
    expect(out.faltantes.map((f: any) => f.campo)).toEqual([
      'dataBloqueio',
      'desdeQuando',
      'uso',
      'revisao',
      'prejuizo',
    ]);
  });

  it('marca completo quando o último obrigatório chega', async () => {
    const { tool } = build({
      dossie: {
        conta: '@x',
        dataBloqueio: 'semana passada',
        desdeQuando: '2019',
        uso: 'vendas',
        revisao: 'pediu, sem resposta',
      },
    });
    const res = await tool.execute({ campo: 'prejuizo', valor: 'não informado' }, ctx);
    expect((res.output as any).completo).toBe(true);
    expect((res.output as any).faltantes).toEqual([]);
  });

  it('acumula observações em vez de sobrescrever', async () => {
    const { tool, prisma } = build({ dossie: { observacoes: 'conta invadida antes' } });
    await tool.execute({ campo: 'observacoes', valor: 'tem BO' }, ctx);
    expect(prisma.contact.update.mock.calls[0][0].data.metadata.dossie.observacoes).toBe(
      'conta invadida antes | tem BO',
    );
  });

  it('recusa campo fora da lista', async () => {
    const { tool, prisma } = build({});
    const res = await tool.execute({ campo: 'cpf', valor: '123' }, ctx);
    expect((res.output as any).ok).toBe(false);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });
});
