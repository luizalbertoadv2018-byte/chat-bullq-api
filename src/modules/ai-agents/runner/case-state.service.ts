import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';

/**
 * Estado do caso lido do banco e entregue ao agente a cada resposta.
 *
 * O agente só enxerga as últimas mensagens da conversa. Com lead falante, a
 * ficha e a assinatura saíam dessa janela e ele recomeçava a triagem, refazia
 * a proposta e gerava um SEGUNDO contrato para quem já tinha assinado. Aqui o
 * que importa (ficha, etapa, documentos) deixa de depender do histórico.
 */
@Injectable()
export class CaseStateService {
  private readonly logger = new Logger(CaseStateService.name);

  constructor(private readonly prisma: PrismaService) {}

  async describe(input: {
    conversationId: string;
    organizationId: string;
    contactMetadata: unknown;
    agentPipelineId: string | null;
    timezone?: string | null;
  }): Promise<string | null> {
    try {
      const meta = (input.contactMetadata ?? {}) as Record<string, any>;
      const signed = meta.tramitacaoReleased === true;
      const pending = !!meta.pendingCadastro?.docToken;

      const card = await this.prisma.card.findFirst({
        where: {
          conversationId: input.conversationId,
          ...(input.agentPipelineId ? { pipelineId: input.agentPipelineId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        select: { stage: { select: { name: true } } },
      });

      // Sem card e sem ficha não há estado a informar (ex.: agente de triagem).
      if (!card && !signed && !pending) return null;

      const lines: string[] = [
        '═══ ESTADO DO CASO (registro do sistema) ═══',
        'Isto vem do banco de dados e vale MAIS do que o histórico da conversa, que pode estar incompleto.',
      ];

      if (signed) {
        const when = this.formatWhen(meta.tramitacaoReleasedAt, input.timezone);
        lines.push(
          `- Ficha/contrato: ASSINADA pelo cliente${when ? ` em ${when}` : ''}. Ele já é cliente do escritório.`,
        );
      } else if (pending) {
        lines.push(
          '- Ficha/contrato: JÁ GERADA e o link já foi enviado. Aguardando o cliente assinar.',
        );
      } else {
        lines.push('- Ficha/contrato: ainda não gerada.');
      }

      if (card?.stage?.name) lines.push(`- Etapa no funil: ${card.stage.name}.`);

      if (input.agentPipelineId) {
        const docs = await this.prisma.documentoBeneficio.findMany({
          where: {
            organizationId: input.organizationId,
            pipelineId: input.agentPipelineId,
          },
          orderBy: { order: 'asc' },
          select: { id: true, name: true },
        });
        const received = (meta.documentos ?? {}) as Record<string, unknown>;
        const got = docs.filter((d) => received[d.id]).map((d) => d.name);
        if (got.length > 0) {
          lines.push(`- Documentos já recebidos: ${got.join('; ')}.`);
        }
      }

      if (meta.clientGroupJid) {
        lines.push('- Grupo do caso com a equipe: já criado.');
      }

      if (signed) {
        lines.push(
          'REGRAS para este estado: é PROIBIDO refazer a triagem, refazer a proposta, pedir de novo os dados da ficha ou gerar outra ficha. ' +
            'Não duvide da assinatura nem peça para o cliente confirmar que assinou. ' +
            'Peça só os documentos básicos que ainda não foram recebidos; depois de pedi-los uma vez, o atendimento está ENCERRADO: ' +
            'responda em UMA frase curta, sem fazer novas perguntas, e deixe a equipe assumir.',
        );
      } else if (pending) {
        lines.push(
          'REGRAS para este estado: NÃO gere outra ficha e não refaça triagem nem proposta. ' +
            'Se o cliente disser que assinou, agradeça e siga para os documentos (a confirmação da assinatura chega sozinha ao sistema). ' +
            'Se ele não achar o link, chame enviarDocumentoAssinatura normalmente: o sistema devolve o link que já existe.',
        );
      }

      return lines.join('\n');
    } catch (err: any) {
      // Estado é um reforço: sem ele o agente segue só com o histórico.
      this.logger.warn(
        `estado do caso indisponível (conv ${input.conversationId}): ${err?.message ?? err}`,
      );
      return null;
    }
  }

  private formatWhen(iso: unknown, timezone?: string | null): string | null {
    if (typeof iso !== 'string' || !iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone || 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  }
}
