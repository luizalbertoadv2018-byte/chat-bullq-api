import { Injectable, Logger } from '@nestjs/common';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { PipelinesService } from '../../../pipelines/pipelines.service';
import { PrismaService } from '../../../../database/prisma.service';

const ETAPAS = [
  'Em Análise',
  'Proposta Enviada',
  'Qualificado',
  'Desqualificado',
] as const;

/**
 * Permite ao agente mover o card desta conversa no funil do tema — a decisão
 * de QUALIFICAÇÃO do lead. Só as etapas comerciais iniciais ficam aqui:
 *   - "Proposta Enviada": o agente acabou de apresentar a proposta de
 *     honorários e aguarda o aceite (só anda em funil que tenha essa etapa).
 *   - "Qualificado": o lead tem caso e quer seguir.
 *   - "Desqualificado": não tem caso, não é o benefício, ou desistiu.
 *   - "Em Análise": ainda avaliando situação/documentos.
 * "Contrato Assinado" NÃO fica aqui (é automático quando o cliente assina).
 * Etapas de processo (Protocolado, Perícia, Deferido) são feitas pela equipe.
 */
@Injectable()
export class MoverNoFunilTool implements AiTool {
  private readonly logger = new Logger(MoverNoFunilTool.name);

  readonly name = 'moverNoFunil';
  readonly description =
    'Move o card desta conversa no funil do tema (qualificação do lead). ' +
    'Use "Proposta Enviada" logo depois de apresentar a proposta de honorários ao lead; ' +
    '"Qualificado" quando o lead TEM caso e quer seguir (aceitou a proposta); "Desqualificado" quando NÃO tem caso, ' +
    'não é o benefício certo, ou desistiu claramente; "Em Análise" quando ainda está avaliando. ' +
    'NÃO use "Contrato Assinado" (isso é automático na assinatura) nem etapas do processo ' +
    '(Protocolado, Perícia, Deferido) — essas a equipe cuida.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['etapa'],
    properties: {
      etapa: {
        type: 'string',
        enum: [...ETAPAS],
        description:
          'Etapa destino: Em Análise | Proposta Enviada | Qualificado | Desqualificado.',
      },
      motivo: {
        type: 'string',
        description: 'Motivo curto da mudança (opcional).',
        maxLength: 280,
      },
    },
  };

  constructor(
    private readonly pipelines: PipelinesService,
    private readonly prisma: PrismaService,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const etapa = String(input.etapa ?? '').trim();
    if (!ETAPAS.includes(etapa as (typeof ETAPAS)[number])) {
      return { output: { ok: false, error: 'etapa inválida', permitidas: ETAPAS } };
    }
    // Depois de assinado o card só anda pra frente, e quem move é o sistema
    // ou a equipe. Sem isso o agente devolvia cliente assinado pra triagem.
    const card = await this.prisma.card.findFirst({
      where: { conversationId: ctx.conversationId },
      orderBy: { updatedAt: 'desc' },
      select: {
        stage: { select: { name: true, order: true, pipelineId: true } },
        contact: { select: { metadata: true } },
      },
    });
    if (card) {
      const signedStage = await this.prisma.pipelineStage.findFirst({
        where: {
          pipelineId: card.stage.pipelineId,
          name: { equals: 'Contrato Assinado', mode: 'insensitive' },
        },
        select: { order: true },
      });
      const meta = (card.contact?.metadata ?? {}) as Record<string, any>;
      const alreadySigned =
        meta.tramitacaoReleased === true ||
        (!!signedStage && card.stage.order >= signedStage.order);
      if (alreadySigned) {
        return {
          output: {
            ok: true,
            movido: false,
            etapaAtual: card.stage.name,
            obs: 'O contrato deste cliente já está assinado: o card não volta para etapas anteriores. Não refaça triagem nem proposta.',
          },
        };
      }
    }

    const res = await this.pipelines.moveConversationCardsToStage(
      ctx.conversationId,
      ctx.organizationId,
      etapa,
    );
    if (res.moved > 0) {
      this.logger.log(
        `IA moveu card → ${res.stage} (conv=${ctx.conversationId}, run=${ctx.runId})`,
      );
      return {
        output: { ok: true, movido: true, etapa: res.stage },
      };
    }
    // Sem card ainda (ex.: agente de triagem sem pipeline) ou já estava lá.
    return {
      output: {
        ok: true,
        movido: false,
        obs: 'Nenhum card desta conversa para mover (ou já estava nessa etapa).',
      },
    };
  }
}
