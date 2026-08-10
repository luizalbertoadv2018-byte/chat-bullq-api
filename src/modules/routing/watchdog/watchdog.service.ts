import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WatchdogConfigService } from './watchdog-config.service';
import {
  WATCHDOG_QUEUE,
  WATCHDOG_CHECK_JOB,
  WatchdogJobData,
} from './watchdog.types';

/**
 * Agenda e cancela jobs reativos do watchdog. Idempotente — agendar uma
 * conversa que já tem job substitui o anterior, cancelar uma sem job é
 * no-op silencioso.
 *
 * Convenção de jobId: `watchdog-{conversationId}` — único por conversa.
 * Isso garante que múltiplas chamadas a `scheduleCheck()` não empilhem
 * timers paralelos pra mesma conversa.
 */
@Injectable()
export class WatchdogService {
  private readonly logger = new Logger(WatchdogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WatchdogConfigService,
    @InjectQueue(WATCHDOG_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Agenda checagem futura pra uma conversa. Chamado quando o cliente
   * manda uma mensagem INBOUND (a janela começa a contar). Se já existe
   * um job pra essa conversa, é substituído pelo novo (delay reseta).
   *
   * Não agenda quando:
   *  - org tem watchdogEnabled=false
   *  - status=WAITING (esperando cliente, nada a fazer)
   *  - status=CLOSED (já fechada)
   *  - aiEnabled=false explícito (humano desligou IA — sagrado)
   */
  async scheduleCheck(conversationId: string): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        organization: {
          select: {
            id: true,
            watchdogEnabled: true,
            watchdogConfig: true,
          },
        },
      },
    });

    if (!conversation) return;
    if (!conversation.organization.watchdogEnabled) return;
    if (conversation.aiEnabled === false) {
      // Humano desativou IA explicitamente — watchdog respeita.
      return;
    }
    if (
      conversation.status === ConversationStatus.WAITING ||
      conversation.status === ConversationStatus.CLOSED
    ) {
      return;
    }

    const cfg = this.config.resolve(conversation.organization);
    const delayMin = this.resolveDelayMin(
      conversation.status,
      conversation.stuckAttempts,
      cfg,
    );
    if (delayMin <= 0) return;

    const jobId = this.jobIdFor(conversationId);

    // Substitui job anterior (se existir) — fluxo: cliente manda 2 mensagens
    // em sequência, o segundo agendamento reseta o timer pro fim da última.
    await this.cancelByJobId(jobId);

    const data: WatchdogJobData = {
      conversationId,
      organizationId: conversation.organizationId,
      scheduledAtAttempts: conversation.stuckAttempts,
    };

    await this.queue.add(WATCHDOG_CHECK_JOB, data, {
      delay: delayMin * 60 * 1000,
      jobId,
      removeOnComplete: 50,
      removeOnFail: 50,
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { watchdogJobId: jobId },
    });

    this.logger.debug(
      `Watchdog scheduled: conv=${conversationId} status=${conversation.status} delayMin=${delayMin}`,
    );
  }

  /**
   * Cancela checagem agendada e zera contador de tentativas. Chamado
   * quando IA ou humano envia uma mensagem OUTBOUND com sucesso — significa
   * que a conversa não está presa.
   */
  async cancelCheck(conversationId: string): Promise<void> {
    const jobId = this.jobIdFor(conversationId);
    await this.cancelByJobId(jobId);

    await this.prisma.conversation
      .update({
        where: { id: conversationId },
        data: {
          watchdogJobId: null,
          stuckAttempts: 0,
          isStuck: false,
        },
      })
      .catch(() => undefined);
  }

  /**
   * Mesmo que `scheduleCheck()` mas sem cancelar/zerar antes — usado pelo
   * cron de fallback que descobriu uma conversa órfã.
   */
  async enqueueFromCron(conversationId: string): Promise<void> {
    return this.scheduleCheck(conversationId);
  }

  /**
   * Delay da PRÓXIMA checagem. Se a org configurou cadência escalonada
   * (`attemptDelaysMin`, ex: [30,60,1440]), usa o delay da tentativa atual
   * (indexado por `stuckAttempts`, com clamp no último). Senão, cai no delay
   * fixo por status (comportamento antigo).
   */
  private resolveDelayMin(
    status: ConversationStatus,
    stuckAttempts: number,
    cfg: ReturnType<WatchdogConfigService['resolve']>,
  ): number {
    const ladder = cfg.attemptDelaysMin;
    if (ladder && ladder.length > 0) {
      const idx = Math.min(Math.max(stuckAttempts, 0), ladder.length - 1);
      return ladder[idx];
    }
    return this.delayForStatus(status, cfg);
  }

  private delayForStatus(
    status: ConversationStatus,
    cfg: ReturnType<WatchdogConfigService['resolve']>,
  ): number {
    switch (status) {
      case ConversationStatus.BOT:
        return cfg.delayBotMin;
      case ConversationStatus.PENDING:
        return cfg.delayPendingMin;
      case ConversationStatus.OPEN:
        return cfg.delayHumanIdleMin;
      default:
        return 0;
    }
  }

  private jobIdFor(conversationId: string): string {
    return `watchdog-${conversationId}`;
  }

  private async cancelByJobId(jobId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      if (job) await job.remove();
    } catch {
      // Job pode não existir ou já estar processado — silencioso.
    }
  }
}
