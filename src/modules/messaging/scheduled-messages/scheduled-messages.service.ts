import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import {
  ChannelAccess,
  ChannelAccessService,
} from '../../iam/channel-access/channel-access.service';
import { CreateScheduledMessageDto } from './dto/create-scheduled-message.dto';
import {
  SCHEDULED_MESSAGES_QUEUE,
  SCHEDULED_MESSAGE_JOB,
  ScheduledMessageJobData,
} from './scheduled-messages.constants';

/** Janela mínima e máxima de agendamento. */
const MIN_DELAY_MS = 30_000; // 30s
const MAX_DELAY_MS = 1000 * 60 * 60 * 24 * 90; // 90 dias

/**
 * Agendamento de mensagens via jobs BullMQ com `delay`. Não precisa de tabela:
 * o job agendado vive no Redis (sobrevive a restart), é listável (getJobs) e
 * cancelável (job.remove). No horário, o processor chama MessagesService.send.
 */
@Injectable()
export class ScheduledMessagesService {
  private readonly logger = new Logger(ScheduledMessagesService.name);

  constructor(
    @InjectQueue(SCHEDULED_MESSAGES_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessService,
  ) {}

  async schedule(
    dto: CreateScheduledMessageDto,
    userId: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
  ) {
    const when = new Date(dto.sendAt);
    if (Number.isNaN(when.getTime())) {
      throw new BadRequestException('Data de envio (sendAt) inválida.');
    }
    const delay = when.getTime() - Date.now();
    if (delay < MIN_DELAY_MS) {
      throw new BadRequestException(
        'Agende para pelo menos ~1 minuto no futuro.',
      );
    }
    if (delay > MAX_DELAY_MS) {
      throw new BadRequestException('Agende para no máximo 90 dias.');
    }

    // Valida acesso à conversa/canal no momento do agendamento.
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: dto.conversationId },
      select: { id: true, organizationId: true, channelId: true },
    });
    if (!conversation || conversation.organizationId !== organizationId) {
      throw new NotFoundException('Conversa não encontrada.');
    }
    this.channelAccess.assertChannelAccess(access, conversation.channelId);

    const data: ScheduledMessageJobData = {
      conversationId: dto.conversationId,
      type: dto.type,
      content: dto.content,
      replyToMessageId: dto.replyToMessageId,
      userId,
      organizationId,
      sendAt: when.toISOString(),
    };

    const job = await this.queue.add(SCHEDULED_MESSAGE_JOB, data, {
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: false,
    });

    this.logger.log(
      `Mensagem agendada conv=${dto.conversationId} para ${when.toISOString()} (job=${job.id})`,
    );
    return {
      id: String(job.id),
      conversationId: dto.conversationId,
      type: dto.type,
      sendAt: when.toISOString(),
    };
  }

  /** Lista os agendamentos PENDENTES da organização (ainda não disparados). */
  async list(organizationId: string) {
    const jobs = (await this.queue.getJobs([
      'delayed',
      'waiting',
      'paused',
    ])) as Job<ScheduledMessageJobData>[];
    const mine = jobs.filter((j) => j?.data?.organizationId === organizationId);
    if (mine.length === 0) return [];

    const convIds = [...new Set(mine.map((j) => j.data.conversationId))];
    const convs = await this.prisma.conversation.findMany({
      where: { id: { in: convIds } },
      select: {
        id: true,
        contact: { select: { name: true, phone: true, avatarUrl: true } },
        channel: { select: { name: true, type: true } },
      },
    });
    const byId = new Map(convs.map((c) => [c.id, c]));

    return mine
      .map((j) => {
        const c = byId.get(j.data.conversationId);
        return {
          id: String(j.id),
          conversationId: j.data.conversationId,
          type: j.data.type,
          content: j.data.content,
          sendAt: j.data.sendAt,
          contactName:
            c?.contact?.name || c?.contact?.phone || 'Conversa',
          contactAvatar: c?.contact?.avatarUrl ?? null,
          channelName: c?.channel?.name ?? null,
        };
      })
      .sort(
        (a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime(),
      );
  }

  /** Cancela um agendamento pendente (remove o job). */
  async cancel(jobId: string, organizationId: string) {
    const job = (await this.queue.getJob(jobId)) as
      | Job<ScheduledMessageJobData>
      | undefined;
    if (!job || job.data?.organizationId !== organizationId) {
      throw new NotFoundException('Agendamento não encontrado.');
    }
    await job.remove();
    this.logger.log(`Agendamento cancelado (job=${jobId})`);
    return { ok: true, id: jobId };
  }
}
