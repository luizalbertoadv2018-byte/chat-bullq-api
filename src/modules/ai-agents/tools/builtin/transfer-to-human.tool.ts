import { Injectable, Logger } from '@nestjs/common';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { PendingActionService } from '../../confirmations/pending-action.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { PrismaService } from '../../../../database/prisma.service';
import { syncConversationStatus } from '../../../messaging/conversations/conversation-status-sync';
import { OwnerAlertService } from '../../../owner-alerts/owner-alert.service';
import { missingDossieFields } from '../../runner/dossie.constants';

/**
 * Hands the conversation off to a human. Pauses AI on this conversation
 * (so the agent stops responding), moves status to PENDING (so it shows
 * up in the queue), and clears the active agent.
 *
 * Fase 2: a operação real ficou atrás de aprovação humana. A tool agora
 * cria um `PendingAction` (impact=critical) e devolve `requiresUserAction`
 * pro LLM. Quando aprovada, o executor da fase 2 faz o pause/handoff de
 * verdade. Mantemos a notificação imediata pro operador (via realtime)
 * pra ele revisar a fila de pendências sem demora.
 */
@Injectable()
export class TransferToHumanTool implements AiTool {
  private readonly logger = new Logger(TransferToHumanTool.name);

  readonly name = 'transferToHuman';
  readonly description =
    'Hand the conversation over to a human agent. Use this when: the request is outside your competence, the customer explicitly asks for a person, the situation is sensitive (complaint, refund, anger), or you are uncertain. The conversation will move to the queue and AI will be paused.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: {
        type: 'string',
        description:
          'Short reason for the handoff, in PT-BR. Visible to the human as an internal note. e.g., "Cliente pediu reembolso, fora do meu escopo".',
        minLength: 3,
        maxLength: 500,
      },
      summary: {
        type: 'string',
        description:
          'Optional short summary of the conversation so far so the human picks up faster.',
        maxLength: 1000,
      },
    },
  };

  constructor(
    private readonly realtime: RealtimeGateway,
    private readonly pendingActions: PendingActionService,
    private readonly prisma: PrismaService,
    private readonly ownerAlerts: OwnerAlertService,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const reason = String(input.reason ?? '').trim() || 'Handoff sem motivo informado';
    const summary = input.summary ? String(input.summary).trim() : null;

    // Cliente que já assinou: a passagem pra equipe é o fim natural do
    // atendimento da IA, não uma decisão a aprovar. O cartão de aprovação
    // expirava sem ninguém ver e a IA seguia conversando (e recomeçando o
    // funil). Aqui a IA silencia na hora e o escritório é avisado.
    const conv = await this.prisma.conversation.findUnique({
      where: { id: ctx.conversationId },
      select: { contact: { select: { metadata: true } } },
    });
    const contactMeta = (conv?.contact?.metadata ?? {}) as Record<string, any>;
    if (contactMeta.tramitacaoReleased === true) {
      await this.prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { aiEnabled: false },
      });
      await syncConversationStatus(
        this.prisma,
        ctx.conversationId,
        'PENDING',
        ['BOT'],
        'ai-handoff-signed-client',
      );
      this.realtime.emitToConversation(
        ctx.conversationId,
        'conversation:updated',
        { conversationId: ctx.conversationId, aiEnabled: false },
      );
      const dossieMissing = missingDossieFields(contactMeta);
      void this.ownerAlerts.notifyAboutConversation(
        ctx.conversationId,
        dossieMissing.length === 0
          ? '\u{1F4C1} Dossiê completo, cliente aguardando a equipe'
          : '\u{1F4C1} Dossiê com pendências, cliente aguardando a equipe',
        (dossieMissing.length > 0
          ? `Faltou: ${dossieMissing.map((f) => f.label).join('; ')}.\n`
          : '') + `A IA encerrou a parte dela. ${reason}`,
      );
      this.logger.log(
        `Agent ${ctx.agentId} encerrou e passou conv ${ctx.conversationId} pra equipe (cliente assinado; sem aprovação)`,
      );
      return {
        output: {
          ok: true,
          status: 'handed_off',
          message:
            'Conversa entregue à equipe. A IA não responde mais nesta conversa.',
          agent_should_say:
            'Não diga que está transferindo. Se ainda não enviou a mensagem de encerramento (a equipe dá seguimento e retorna em breve), envie agora; senão, não envie mais nada.',
        },
        finalAction: 'TRANSFERRED_TO_HUMAN',
      };
    }

    const preview = {
      action: `Transferir conversa pro atendimento humano: ${reason}`,
      impact: 'critical' as const,
      rollback:
        'Reativar IA na conversa (aiEnabled=true) e devolver pra fila do bot.',
      affectedEntity: {
        type: 'conversation' as const,
        id: ctx.conversationId,
        label: `conversation:${ctx.conversationId}`,
      },
    };

    const action = await this.pendingActions.create({
      agentRunId: ctx.runId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      toolName: this.name,
      args: { reason, summary },
      preview,
    });

    // Notifica o operador imediatamente — ele revisa a fila de pendências
    // e aprova/rejeita. A pausa da IA acontece SOMENTE após aprovação,
    // pelo executor da fase 2.
    this.realtime.emitToConversation(
      ctx.conversationId,
      'conversation:pending-action',
      {
        conversationId: ctx.conversationId,
        pendingActionId: action.id,
        toolName: this.name,
        impact: preview.impact,
        reason,
      },
    );

    this.logger.log(
      `Agent ${ctx.agentId} requested handoff for conv ${ctx.conversationId} → pendingAction=${action.id} (reason="${reason}")`,
    );

    return {
      output: {
        ok: true,
        status: 'queued_for_processing',
        pendingActionId: action.id,
        preview,
        message:
          'Transferência registrada com sucesso. Atendente humano vai assumir em instantes — fluxo padrão, não é erro.',
        agent_should_say:
          'Avise o cliente, com naturalidade, que um atendente humano vai continuar o atendimento agora. NÃO mencione "aprovação", "operador", "PendingAction" ou qualquer detalhe interno.',
      },
      // Mantém o sinal de "saí do loop" — o agent deve parar de responder
      // até o operador decidir. Sem isso o LLM seguiria conversando como
      // se tivesse transferido de fato.
      finalAction: 'TRANSFERRED_TO_HUMAN',
    };
  }
}
