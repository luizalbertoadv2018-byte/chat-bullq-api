import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { PipelinesService } from '../../pipelines/pipelines.service';

/**
 * Auto-card por tema: quando um agente de tema (que tem `pipelineId` de destino)
 * assume uma conversa, cria automaticamente um card no 1º estágio ("Novo") do
 * pipeline daquele tema. Ex.: lead de Auxílio-Acidente → o agente Ana Júlia
 * assume → card nasce no pipeline AUXÍLIO ACIDENTE / Novo.
 *
 * Idempotente: se a conversa já tem card naquele pipeline, é no-op. Agente sem
 * pipeline (ex.: triagem) não gera card — o card só nasce quando o tema é
 * identificado por um agente de tema.
 */
@Injectable()
export class ThemeCardService {
  private readonly logger = new Logger(ThemeCardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelines: PipelinesService,
  ) {}

  async ensureForConversation(
    conversationId: string,
    organizationId: string,
    agentId: string,
  ): Promise<void> {
    const agent = await this.prisma.aiAgent.findUnique({
      where: { id: agentId },
      select: { pipelineId: true },
    });
    const pipelineId = agent?.pipelineId;
    if (!pipelineId) return; // agente sem pipeline de destino (ex.: triagem)

    // Já tem card nesse pipeline? No-op (não duplica).
    const existing = await this.prisma.card.findFirst({
      where: { pipelineId, conversationId },
      select: { id: true },
    });
    if (existing) return;

    try {
      // createCard hidrata título/contato da conversa e usa o 1º estágio (order asc).
      await this.pipelines.createCard(pipelineId, organizationId, {
        conversationId,
      } as any);
      this.logger.log(
        `auto-card: conversa ${conversationId} → pipeline ${pipelineId} (agente ${agentId})`,
      );
    } catch (err: any) {
      // BadRequest de duplicata (corrida) ou pipeline sem stage → no-op.
      this.logger.warn(
        `auto-card no-op p/ conversa ${conversationId}: ${err?.message ?? err}`,
      );
    }
  }
}
