import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MessagesService } from '../messages/messages.service';
import {
  SCHEDULED_MESSAGES_QUEUE,
  ScheduledMessageJobData,
} from './scheduled-messages.constants';

/**
 * Dispara a mensagem agendada no horário (delay do job). Reaproveita o
 * MessagesService.send — mesmo pipeline de qualquer mensagem manual. Acesso
 * = 'ALL' porque a permissão já foi validada no agendamento; senderId é quem
 * agendou.
 */
@Processor(SCHEDULED_MESSAGES_QUEUE, { concurrency: 5 })
export class ScheduledMessagesProcessor extends WorkerHost {
  private readonly logger = new Logger(ScheduledMessagesProcessor.name);

  constructor(private readonly messages: MessagesService) {
    super();
  }

  async process(job: Job<ScheduledMessageJobData>): Promise<void> {
    const d = job.data;
    if (!d?.conversationId) return;
    await this.messages.send(
      {
        conversationId: d.conversationId,
        type: d.type,
        content: d.content as Record<string, any>,
        replyToMessageId: d.replyToMessageId,
      },
      d.userId,
      d.organizationId,
      'ALL',
    );
    this.logger.log(
      `Mensagem agendada enviada conv=${d.conversationId} (job=${job.id})`,
    );
  }
}
