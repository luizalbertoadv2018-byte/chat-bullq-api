import { Injectable, Logger } from '@nestjs/common';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { PrismaService } from '../../../../database/prisma.service';
import { DocumentosBeneficioService } from '../../../documentos-beneficio/documentos-beneficio.service';

/**
 * Checklist de documentos do benefício do lead. A IA usa pra saber o que o
 * cliente JÁ mandou e COBRAR o que falta antes de protocolar. O benefício é
 * resolvido pelo pipeline do agente que atende (Ana Júlia → Auxílio Acidente,
 * etc.). O "recebido" fica em contact.metadata.documentos[docId].
 */
@Injectable()
export class ChecklistDocumentosTool implements AiTool {
  private readonly logger = new Logger(ChecklistDocumentosTool.name);

  readonly name = 'checklistDocumentos';
  readonly description =
    'Gerencia o checklist de documentos que ESTE benefício exige do cliente. ' +
    'Ações: "faltantes" → lista o que o cliente AINDA precisa enviar (use pra cobrar); ' +
    '"ver" → lista completa com o que já foi recebido; ' +
    '"marcar" → marca um documento como RECEBIDO (passe "documento" com o nome, ex.: "RG", "CNIS", "laudo") — ' +
    'use quando o cliente enviar/confirmar um documento. Sempre confira o checklist antes de dizer que pode protocolar.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['acao'],
    properties: {
      acao: { type: 'string', enum: ['faltantes', 'ver', 'marcar'] },
      documento: {
        type: 'string',
        description: 'Em "marcar": nome do documento recebido (casa por aproximação).',
        maxLength: 80,
      },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentos: DocumentosBeneficioService,
  ) {}

  private norm(s: string): string {
    return Array.from((s ?? '').normalize('NFD'))
      .filter((ch) => {
        const c = ch.codePointAt(0) ?? 0;
        return c < 0x0300 || c > 0x036f;
      })
      .join('')
      .toLowerCase()
      .trim();
  }

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const acao = String(input.acao ?? '');

    // Resolve o benefício pelo pipeline do agente que atende.
    const agent = await this.prisma.aiAgent.findUnique({
      where: { id: ctx.agentId },
      select: { pipelineId: true },
    });
    if (!agent?.pipelineId) {
      return {
        output: {
          ok: false,
          semChecklist: true,
          obs: 'Este agente não tem um benefício/pipeline definido — sem checklist de documentos.',
        },
      };
    }

    const docs = await this.documentos.findByPipeline(
      ctx.organizationId,
      agent.pipelineId,
    );
    if (docs.length === 0) {
      return {
        output: {
          ok: false,
          semChecklist: true,
          obs: 'Nenhum documento configurado para este benefício ainda.',
        },
      };
    }

    const contact = await this.prisma.contact.findUnique({
      where: { id: ctx.contactId },
      select: { metadata: true },
    });
    const meta = (contact?.metadata ?? {}) as Record<string, any>;
    const recebidos: Record<string, any> = meta.documentos ?? {};

    if (acao === 'marcar') {
      const alvo = this.norm(String(input.documento ?? ''));
      if (!alvo) {
        return { output: { ok: false, error: 'Informe o documento em "documento".' } };
      }
      let doc = docs.find((d) => this.norm(d.name) === alvo);
      if (!doc) doc = docs.find((d) => this.norm(d.name).includes(alvo) || alvo.includes(this.norm(d.name)));
      if (!doc) {
        return {
          output: {
            ok: false,
            error: `Documento "${input.documento}" não está na lista deste benefício.`,
            documentos: docs.map((d) => d.name),
          },
        };
      }
      const novos = {
        ...recebidos,
        [doc.id]: { recebido: true, em: new Date().toISOString() },
      };
      await this.prisma.contact.update({
        where: { id: ctx.contactId },
        data: { metadata: { ...meta, documentos: novos } as any },
      });
      const faltam = docs.filter((d) => !novos[d.id]);
      this.logger.log(
        `checklist: marcado "${doc.name}" recebido (contato ${ctx.contactId}); faltam ${faltam.length}`,
      );
      return {
        output: {
          ok: true,
          marcado: doc.name,
          completo: faltam.length === 0,
          faltantes: faltam.map((d) => d.name),
        },
      };
    }

    // ver / faltantes
    const lista = docs.map((d) => ({
      documento: d.name,
      recebido: !!recebidos[d.id],
    }));
    const faltantes = lista.filter((d) => !d.recebido).map((d) => d.documento);
    return {
      output: {
        ok: true,
        beneficio: agent.pipelineId,
        completo: faltantes.length === 0,
        faltantes,
        ...(acao === 'ver' ? { checklist: lista } : {}),
      },
    };
  }
}
