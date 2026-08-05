/** Fila BullMQ de mensagens agendadas (jobs com delay = horário de envio). */
export const SCHEDULED_MESSAGES_QUEUE = 'scheduled-messages';
export const SCHEDULED_MESSAGE_JOB = 'send-scheduled';

/** Payload do job agendado. */
export interface ScheduledMessageJobData {
  conversationId: string;
  type: string;
  content: Record<string, unknown>;
  replyToMessageId?: string;
  /** Quem agendou (vira o senderId da mensagem no disparo). */
  userId: string;
  organizationId: string;
  /** ISO — só p/ exibição/ordenção na listagem. */
  sendAt: string;
}
