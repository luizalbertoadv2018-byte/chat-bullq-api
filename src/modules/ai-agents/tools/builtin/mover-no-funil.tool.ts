import { Injectable, Logger } from '@nestjs/common';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { PipelinesService } from '../../../pipelines/pipelines.service';

const ETAPAS = ['Em Análise', 'Qualificado', 'Desqualificado'] as const;

/**
 * Permite ao agente mover o card desta conversa no funil do tema — a decisão
 * de QUALIFICAÇÃO do lead. Só as etapas comerciais iniciais ficam aqui:
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
    'Use "Qualificado" quando o lead TEM caso e quer seguir; "Desqualificado" quando NÃO tem caso, ' +
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
        description: 'Etapa destino: Em Análise | Qualificado | Desqualificado.',
      },
      motivo: {
        type: 'string',
        description: 'Motivo curto da mudança (opcional).',
        maxLength: 280,
      },
    },
  };

  constructor(private readonly pipelines: PipelinesService) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const etapa = String(input.etapa ?? '').trim();
    if (!ETAPAS.includes(etapa as (typeof ETAPAS)[number])) {
      return { output: { ok: false, error: 'etapa inválida', permitidas: ETAPAS } };
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
