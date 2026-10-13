import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AiAgentsModule } from '../ai-agents/ai-agents.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { FollowUpController } from './follow-up.controller';
import { FollowUpProcessor } from './follow-up.processor';
import { FollowUpService } from './follow-up.service';
import { FollowUpSummaryService } from './follow-up-summary.service';
import { FOLLOW_UP_QUEUE, FOLLOW_UP_SUMMARY_JOB } from './follow-up.rules';

/** Resumo diário: dias úteis, 9h de Brasília. */
const SUMMARY_PATTERN = '0 9 * * 1-5';

/**
 * Follow-up de leads que pararam de responder + resumo diário da equipe.
 *
 * Global porque `FollowUpService` é chamado das bordas onde as mensagens
 * entram e saem (inbound, resposta humana, assinatura), em módulos
 * diferentes. Nenhum módulo importado aqui importa este de volta.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: FOLLOW_UP_QUEUE }),
    AiAgentsModule,
    PipelinesModule,
  ],
  controllers: [FollowUpController],
  providers: [FollowUpService, FollowUpSummaryService, FollowUpProcessor],
  exports: [FollowUpService],
})
export class FollowUpModule implements OnModuleInit {
  private readonly logger = new Logger(FollowUpModule.name);

  constructor(@InjectQueue(FOLLOW_UP_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      // Um agendamento com horário antigo continuaria disparando ao lado do
      // novo: a fila guarda cada padrão como uma repetição separada.
      for (const job of await this.queue.getRepeatableJobs()) {
        if (job.name === FOLLOW_UP_SUMMARY_JOB && job.pattern !== SUMMARY_PATTERN) {
          await this.queue.removeRepeatableByKey(job.key);
        }
      }
      await this.queue.add(
        FOLLOW_UP_SUMMARY_JOB,
        {},
        {
          repeat: { pattern: SUMMARY_PATTERN, tz: 'America/Sao_Paulo' },
          jobId: 'follow-up-daily-summary',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
    } catch (err: any) {
      this.logger.error(
        `resumo diário não foi agendado: ${err?.message ?? err}`,
      );
    }
  }
}
