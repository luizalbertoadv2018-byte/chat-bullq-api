import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MessageDirection } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AiAgentRunnerService } from '../ai-agents/runner/agent-runner.service';
import { AgentRouterService } from '../ai-agents/router/agent-router.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { OwnerAlertService } from '../owner-alerts/owner-alert.service';
import { FollowUpService } from './follow-up.service';
import { FollowUpSummaryService } from './follow-up-summary.service';
import {
  BusinessHours,
  isWithinBusinessHours,
  nextBusinessInstant,
} from './business-hours.util';
import {
  AUDIT_FOLLOW_UP_EXHAUSTED,
  AUDIT_FOLLOW_UP_SENT,
  FOLLOW_UP_BACKFILL_JOB,
  FOLLOW_UP_JOB,
  FOLLOW_UP_QUEUE,
  FollowUpBackfillData,
  FOLLOW_UP_SUMMARY_JOB,
  FollowUpJobData,
  NO_RETURN_STAGE,
  buildFollowUpNote,
  classifyStage,
  isBasicDocument,
  isOptOut,
} from './follow-up.rules';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Quando o teto diário estoura, tenta de novo depois disso. */
const CAP_RETRY_MS = 3 * 60 * 60 * 1000;

/**
 * Quando o prazo de silêncio vence, relê o estado ATUAL da conversa e decide:
 * não é mais o caso (lead respondeu, humano assumiu, etapa não cabe), ainda
 * não é hora (fora do horário, teto do dia), mandar a retomada pela IA, ou
 * encerrar (card para "Sem Retorno").
 *
 * `concurrency: 1`: os envios saem um de cada vez, o que também espaça as
 * mensagens no número.
 */
@Processor(FOLLOW_UP_QUEUE, { concurrency: 1 })
export class FollowUpProcessor extends WorkerHost {
  private readonly logger = new Logger(FollowUpProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly followUp: FollowUpService,
    private readonly summary: FollowUpSummaryService,
    private readonly agentRunner: AiAgentRunnerService,
    private readonly agentRouter: AgentRouterService,
    private readonly pipelines: PipelinesService,
    private readonly ownerAlerts: OwnerAlertService,
  ) {
    super();
  }

  async process(job: Job<FollowUpJobData>): Promise<unknown> {
    if (job.name === FOLLOW_UP_SUMMARY_JOB) return this.summary.sendAll();
    if (job.name === FOLLOW_UP_BACKFILL_JOB) {
      return this.followUp.backfill(job.data as unknown as FollowUpBackfillData);
    }
    if (job.name !== FOLLOW_UP_JOB) return { skipped: 'unknown-job' };
    try {
      const result = await this.handle(job.data.conversationId, String(job.id));
      this.logger.log(
        `follow-up conv=${job.data.conversationId}: ${JSON.stringify(result)}`,
      );
      return result;
    } catch (err: any) {
      // Não relança: retentar um follow-up arrisca mandar mensagem em dobro.
      this.logger.error(
        `follow-up falhou (conv ${job.data.conversationId}): ${err?.message ?? err}`,
      );
      return { error: err?.message ?? String(err) };
    }
  }

  private async stop(conversationId: string, reason: string) {
    await this.followUp.saveState(conversationId, {
      nextAt: null,
      jobId: null,
      stopReason: reason,
    });
    return { stopped: reason };
  }

  private async handle(
    conversationId: string,
    jobId: string,
  ): Promise<Record<string, unknown>> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        contact: { select: { id: true, name: true, metadata: true } },
        organization: {
          select: { watchdogBusinessHours: true, aiTimezone: true },
        },
      },
    });
    if (!conversation || conversation.deletedAt) return { skipped: 'gone' };
    if (conversation.isGroup) return this.stop(conversationId, 'group');
    if (conversation.aiEnabled === false) return this.stop(conversationId, 'ai-off');

    const state = this.followUp.readState(conversation.metadata);
    // Job velho: a conversa foi reagendada ou cancelada depois dele.
    if (state.jobId !== jobId) return { skipped: 'stale-job' };
    if (state.paused) return { skipped: 'paused' };

    const { cfg } = await this.followUp.configFor(conversation);
    if (!cfg.enabled) return this.stop(conversationId, 'disabled');

    // Só é follow-up se fomos nós a falar por último.
    const [lastMessage, lastInbound] = await Promise.all([
      this.prisma.message.findFirst({
        where: { conversationId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.message.findFirst({
        where: { conversationId, direction: MessageDirection.INBOUND },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    if (!lastMessage || lastMessage.direction !== MessageDirection.OUTBOUND) {
      return this.stop(conversationId, 'lead-spoke-last');
    }
    if (isOptOut((lastInbound?.content as any)?.text)) {
      return this.stop(conversationId, 'opt-out');
    }

    const card = await this.prisma.card.findFirst({
      where: { conversationId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        stageId: true,
        pipelineId: true,
        stage: { select: { name: true } },
      },
    });
    const kind = classifyStage(card?.stage.name);
    if (!card || kind === 'none') return this.stop(conversationId, 'stage');

    // Depois da assinatura só há o que cobrar se faltar documento básico.
    let missingDocs: string[] = [];
    if (kind === 'post-sign') {
      missingDocs = await this.missingBasicDocs(
        conversation.organizationId,
        card.pipelineId,
        conversation.contact.metadata,
      );
      if (missingDocs.length === 0) return this.stop(conversationId, 'docs-complete');
    }

    const attempts = state.attempts ?? 0;
    const maxAttempts = cfg.cadenceMinutes.length;

    // Tentativas esgotadas e o prazo final venceu: encerra.
    if (attempts >= maxAttempts) {
      return this.exhaust(conversation, card, kind, missingDocs);
    }

    // Fora do horário: espera a próxima janela (sem gastar tentativa).
    const tz = conversation.organization.aiTimezone || 'America/Sao_Paulo';
    const hours = conversation.organization.watchdogBusinessHours as unknown as BusinessHours;
    const now = new Date();
    if (!cfg.testMode && !isWithinBusinessHours(hours, tz, now)) {
      const next = nextBusinessInstant(hours, tz, now);
      const delayMs = Math.max(next.getTime() - now.getTime(), 60_000) +
        Math.floor(Math.random() * 20 * 60_000);
      await this.followUp.schedule(conversationId, { delayMs });
      return { rescheduled: 'outside-business-hours', delayMin: Math.round(delayMs / 60_000) };
    }

    // Teto diário do número.
    const sentLastDay = await this.prisma.conversationAuditLog.count({
      where: {
        action: AUDIT_FOLLOW_UP_SENT,
        createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        conversation: { organizationId: conversation.organizationId },
      },
    });
    if (!cfg.testMode && sentLastDay >= cfg.dailyCap) {
      await this.followUp.schedule(conversationId, { delayMs: CAP_RETRY_MS });
      return { rescheduled: 'daily-cap', sentLastDay };
    }

    const decision = await this.agentRouter.shouldHandle(conversation);
    if (!decision.handle) return this.stop(conversationId, `router:${decision.reason}`);

    const silenceMinutes = (now.getTime() - lastMessage.createdAt.getTime()) / 60_000;
    const attempt = attempts + 1;
    const note = buildFollowUpNote({
      stageName: card.stage.name,
      kind,
      silenceMinutes,
      attempt,
      maxAttempts,
      missingDocs,
    });

    if (cfg.dryRun) {
      await this.prisma.conversationAuditLog.create({
        data: {
          conversationId,
          action: 'FOLLOW_UP_DRY_RUN',
          toValue: String(attempt),
          metadata: { stage: card.stage.name, silenceMinutes: Math.round(silenceMinutes) },
        },
      });
      return this.stop(conversationId, 'dry-run');
    }

    const startedAt = new Date();
    await this.agentRunner.run({
      conversation,
      triggerMessage: lastInbound ?? lastMessage,
      systemNote: note,
    });

    const sent = await this.prisma.message.findFirst({
      where: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        createdAt: { gte: startedAt },
      },
      select: { id: true },
    });
    if (!sent) return this.stop(conversationId, 'ai-did-not-reply');

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId,
        action: AUDIT_FOLLOW_UP_SENT,
        toValue: String(attempt),
        metadata: {
          stage: card.stage.name,
          messageId: sent.id,
          silenceMinutes: Math.round(silenceMinutes),
        },
      },
    });
    await this.followUp.saveState(conversationId, {
      attempts: attempt,
      lastSentAt: new Date().toISOString(),
    });
    // Próximo passo: a tentativa seguinte ou, se esta foi a última, o prazo
    // até encerrar.
    await this.followUp.schedule(conversationId);
    return { sent: attempt, of: maxAttempts, stage: card.stage.name };
  }

  private async exhaust(
    conversation: { id: string; organizationId: string },
    card: { id: string; stageId: string; stage: { name: string } },
    kind: 'pre-sign' | 'post-sign',
    missingDocs: string[],
  ) {
    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: conversation.id,
        action: AUDIT_FOLLOW_UP_EXHAUSTED,
        fromValue: card.stage.name,
        metadata: { kind },
      },
    });

    if (kind === 'post-sign') {
      // Cliente assinado não vira "Sem Retorno": a equipe é avisada.
      await this.ownerAlerts.notifyAboutConversation(
        conversation.id,
        '📭 Cliente assinado sem retorno',
        `Cobrei duas vezes e não respondeu. Falta: ${missingDocs.join('; ')}.`,
      );
      await this.followUp.saveState(conversation.id, {
        nextAt: null,
        jobId: null,
        stopReason: 'exhausted',
      });
      return { exhausted: 'post-sign' };
    }

    const res = await this.pipelines.moveConversationCardsToStage(
      conversation.id,
      conversation.organizationId,
      NO_RETURN_STAGE,
    );
    await this.followUp.saveState(conversation.id, {
      nextAt: null,
      jobId: null,
      stopReason: 'exhausted',
      // Sem a coluna criada o card fica onde está; não há pra onde voltar.
      previousStageId: res.moved > 0 ? card.stageId : null,
    });
    return { exhausted: 'pre-sign', moved: res.moved };
  }

  private async missingBasicDocs(
    organizationId: string,
    pipelineId: string,
    contactMetadata: unknown,
  ): Promise<string[]> {
    const docs = await this.prisma.documentoBeneficio.findMany({
      where: { organizationId, pipelineId },
      orderBy: { order: 'asc' },
      select: { id: true, name: true },
    });
    const received = (((contactMetadata ?? {}) as Record<string, any>).documentos ??
      {}) as Record<string, unknown>;
    return docs
      .filter((d) => isBasicDocument(d.name) && !received[d.id])
      .map((d) => d.name);
  }
}
