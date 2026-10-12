import { ConversationStatus, PrismaClient } from '@prisma/client';

/**
 * Mantém o `status` da conversa fiel a quem está com ela, sem depender de
 * alguém trocar à mão no painel:
 *
 *   - IA atendendo            → BOT ("IA / Bot")
 *   - IA passou para a equipe → PENDING ("Pendente", aguardando um humano)
 *   - humano respondeu        → OPEN ("Em atendimento")
 *
 * Só troca quando o status atual está em `from` (o updateMany é a trava, sem
 * corrida com outra mudança) e registra a troca na auditoria da conversa.
 * Não passa pela FSM de propósito: é reflexo de quem está atendendo, não uma
 * decisão do operador, e não deve disparar automação de "status alterado".
 * Nunca lança. Devolve true quando trocou.
 */
export async function syncConversationStatus(
  prisma: Pick<PrismaClient, 'conversation' | 'conversationAuditLog'>,
  conversationId: string,
  to: ConversationStatus,
  from: ConversationStatus[],
  reason: string,
): Promise<boolean> {
  try {
    const current = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { status: true },
    });
    if (!current || current.status === to || !from.includes(current.status)) {
      return false;
    }
    const res = await prisma.conversation.updateMany({
      where: { id: conversationId, status: current.status },
      data: { status: to },
    });
    if (res.count === 0) return false;
    await prisma.conversationAuditLog.create({
      data: {
        conversationId,
        action: 'STATUS_CHANGED',
        fromValue: current.status,
        toValue: to,
        metadata: { auto: true, reason },
      },
    });
    return true;
  } catch {
    return false;
  }
}
