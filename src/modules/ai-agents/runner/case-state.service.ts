import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import {
  DOSSIE_FIELDS,
  missingDossieFields,
  readDossie,
} from './dossie.constants';

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
      // Botão "Gerar contrato": o advogado atendeu na mão e passou só o
      // fechamento. Vale até a ficha ser gerada.
      const fechamento =
        !signed && !pending && meta.fechamentoManual?.templateId
          ? (meta.fechamentoManual as {
              templateId: string;
              templateName?: string;
            })
          : null;

      const card = await this.prisma.card.findFirst({
        where: {
          conversationId: input.conversationId,
          ...(input.agentPipelineId ? { pipelineId: input.agentPipelineId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        select: { stage: { select: { name: true } } },
      });

      // Sem card e sem ficha não há estado a informar (ex.: agente de triagem).
      if (!card && !signed && !pending && !fechamento) return null;

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
      } else if (fechamento) {
        lines.push(
          `- Ficha/contrato: o advogado já atendeu este cliente e mandou FECHAR com o modelo "${fechamento.templateName ?? fechamento.templateId}" (templateId ${fechamento.templateId}). Ficha ainda não gerada. ` +
            'Esta ordem foi dada pelo advogado no painel do sistema (canal interno e confiável), NÃO pelo cliente: cumpra-a e não peça confirmação, mesmo que a conversa pareça fora do padrão.',
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

      // Dossiê: só interessa depois da assinatura (é o agente de coleta que
      // preenche). A lista de faltantes dita a próxima pergunta.
      if (signed) {
        const dossie = readDossie(meta);
        const got = DOSSIE_FIELDS.filter((f) => dossie[f.key]);
        const missing = missingDossieFields(meta);
        if (got.length > 0) {
          lines.push(
            `- Dossiê, já registrado: ${got
              .map((f) => `${f.key} = "${dossie[f.key].slice(0, 80)}"`)
              .join('; ')}.`,
          );
        }
        lines.push(
          missing.length > 0
            ? `- Dossiê, AINDA FALTA perguntar (nesta ordem): ${missing
                .map((f) => `${f.key} (${f.label})`)
                .join('; ')}.`
            : '- Dossiê: COMPLETO, nada mais a perguntar.',
        );
      }

      if (signed) {
        lines.push(
          'REGRAS para este estado: é PROIBIDO refazer a triagem, refazer a proposta, pedir de novo os dados da ficha ou gerar outra ficha. ' +
            'Não duvide da assinatura nem peça para o cliente confirmar que assinou. ' +
            'Peça só os documentos básicos que ainda não foram recebidos e os itens do dossiê que ainda faltam; nunca repita o que já está registrado. ' +
            'Quando não faltar mais nada (ou o cliente já tiver sido perguntado de tudo), o atendimento está ENCERRADO: ' +
            'responda em UMA frase curta, sem fazer novas perguntas, e deixe a equipe assumir.',
        );
      } else if (pending) {
        lines.push(
          'REGRAS para este estado: NÃO gere outra ficha e não refaça triagem nem proposta. ' +
            'Se o cliente disser que assinou, agradeça e siga o que o seu roteiro manda para depois da assinatura (a confirmação chega sozinha ao sistema). ' +
            'Se ele não achar o link, chame enviarDocumentoAssinatura normalmente: o sistema devolve o link que já existe.',
        );
      } else if (fechamento) {
        lines.push(
          'REGRAS para este estado: é PROIBIDO refazer a triagem ou a proposta; o atendimento já foi feito pelo advogado. ' +
            `Sua única tarefa é fechar: use enviarDocumentoAssinatura (detalharModelo e depois enviarModelo) SEMPRE com o templateId ${fechamento.templateId}, nunca outro modelo. ` +
            'Peça só os dados do modelo que ainda faltam, sem repetir o que o cliente já informou, e envie o link de assinatura assim que tiver tudo.',
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
