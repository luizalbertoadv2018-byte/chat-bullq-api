import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import {
  FOLLOW_UP_JOB,
  FOLLOW_UP_QUEUE,
  FollowUpJobData,
  FollowUpSettings,
  FollowUpState,
  NO_RETURN_STAGE,
  ResolvedFollowUpConfig,
  delayForStep,
  resolveFollowUpConfig,
} from './follow-up.rules';

/** Atraso sorteado pra os envios não saírem todos no mesmo minuto. */
const JITTER_MAX_MS = 10 * 60 * 1000;

/**
 * Agenda e cancela o follow-up de uma conversa: retomar o lead que parou de
 * responder depois que NÓS falamos por último (o watchdog cobre o caso
 * inverso). Um job atrasado por conversa, no molde do `WatchdogService`.
 * O id do job muda a cada agendamento (o processador reagenda de dentro do
 * próprio job, e a fila recusaria repetir o id de um job ainda ativo); o id
 * vigente fica no estado, em `conversations.metadata.followUp`.
 *
 * Nunca lança: follow-up é acessório e não pode derrubar o fluxo de mensagem
 * que o chamou.
 */
@Injectable()
export class FollowUpService {
  private readonly logger = new Logger(FollowUpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelines: PipelinesService,
    @InjectQueue(FOLLOW_UP_QUEUE) private readonly queue: Queue,
  ) {}

  private newJobId(conversationId: string): string {
    return `followup-${conversationId}-${Date.now().toString(36)}`;
  }

  readState(metadata: unknown): FollowUpState {
    const fu = ((metadata ?? {}) as Record<string, any>).followUp;
    return fu && typeof fu === 'object' ? (fu as FollowUpState) : {};
  }

  /** Mescla `patch` no estado, relendo o metadata pra não atropelar outro campo. */
  async saveState(
    conversationId: string,
    patch: Partial<FollowUpState>,
  ): Promise<FollowUpState> {
    const fresh = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const metadata = (fresh?.metadata ?? {}) as Record<string, any>;
    const next = { ...this.readState(metadata), ...patch };
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { metadata: { ...metadata, followUp: next } as any },
    });
    return next;
  }

  /** Agente que atende a conversa: o ativo, senão o autônomo do canal. */
  async resolveAgentId(conversation: {
    activeAgentId: string | null;
    channelId: string;
  }): Promise<string | null> {
    if (conversation.activeAgentId) return conversation.activeAgentId;
    const link = await this.prisma.aiAgentChannel.findFirst({
      where: {
        channelId: conversation.channelId,
        mode: 'AUTONOMOUS',
        agent: { isActive: true, deletedAt: null },
      },
      select: { agentId: true },
    });
    return link?.agentId ?? null;
  }

  async configFor(conversation: {
    organizationId: string;
    activeAgentId: string | null;
    channelId: string;
    metadata: unknown;
  }): Promise<{ cfg: ResolvedFollowUpConfig; agentId: string | null }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: conversation.organizationId },
      select: { settings: true },
    });
    const settings = ((org?.settings ?? {}) as Record<string, any>).followUp as
      | FollowUpSettings
      | undefined;
    const agentId = await this.resolveAgentId(conversation);
    return {
      cfg: resolveFollowUpConfig(settings, agentId, this.readState(conversation.metadata)),
      agentId,
    };
  }

  private async removeJob(jobId: string | null | undefined): Promise<void> {
    if (!jobId) return;
    const job = await this.queue.getJob(jobId);
    // O job em execução não pode ser removido; ele termina sozinho.
    if (job) await job.remove().catch(() => undefined);
  }

  /**
   * Agenda o próximo passo (tentativa ou encerramento) a partir de agora.
   * Chamar logo depois que a IA fala com o lead. Substitui o agendamento
   * anterior. `delayMs` força um prazo (reagendamento por horário/teto).
   */
  async schedule(
    conversationId: string,
    opts: { delayMs?: number } = {},
  ): Promise<void> {
    try {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
      });
      if (!conversation || conversation.deletedAt) return;
      if (conversation.isGroup || conversation.aiEnabled === false) return;

      const state = this.readState(conversation.metadata);
      if (state.paused) return;

      const { cfg } = await this.configFor(conversation);
      if (!cfg.enabled) return;

      const attempts = state.attempts ?? 0;
      const delayMs =
        opts.delayMs ??
        delayForStep(attempts, cfg) * 60_000 +
          (cfg.testMode ? 0 : Math.floor(Math.random() * JITTER_MAX_MS));

      await this.removeJob(state.jobId);
      const jobId = this.newJobId(conversationId);
      const data: FollowUpJobData = { conversationId };
      await this.queue.add(FOLLOW_UP_JOB, data, {
        delay: delayMs,
        jobId,
        removeOnComplete: 50,
        removeOnFail: 50,
      });
      await this.saveState(conversationId, {
        nextAt: new Date(Date.now() + delayMs).toISOString(),
        jobId,
        stopReason: null,
      });
      this.logger.debug(
        `follow-up agendado: conv=${conversationId} passo=${attempts + 1} em ${Math.round(delayMs / 60_000)} min`,
      );
    } catch (err: any) {
      this.logger.warn(
        `follow-up não agendado (conv ${conversationId}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Cancela o agendamento e zera as tentativas. Não grava nada em conversa
   * que nunca teve follow-up (a maioria), pra não tocar o metadata à toa.
   */
  async cancel(conversationId: string, reason: string): Promise<void> {
    try {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { metadata: true },
      });
      const state = this.readState(conversation?.metadata);
      if (!state.jobId && !state.nextAt && !state.attempts) return;
      await this.removeJob(state.jobId);
      await this.saveState(conversationId, {
        attempts: 0,
        nextAt: null,
        jobId: null,
        stopReason: reason,
      });
    } catch (err: any) {
      this.logger.warn(
        `follow-up não cancelado (conv ${conversationId}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * O lead falou: para o follow-up e, se o card tinha ido para "Sem Retorno",
   * devolve à etapa em que ele estava.
   */
  async onInbound(conversationId: string): Promise<void> {
    try {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { metadata: true, organizationId: true },
      });
      if (!conversation) return;
      const state = this.readState(conversation.metadata);
      await this.cancel(conversationId, 'lead-replied');
      if (!state.previousStageId) return;

      const card = await this.prisma.card.findFirst({
        where: { conversationId },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, stage: { select: { name: true } } },
      });
      if (
        card &&
        card.stage.name.trim().toLowerCase() === NO_RETURN_STAGE.toLowerCase()
      ) {
        await this.pipelines.moveCard(card.id, conversation.organizationId, {
          toStageId: state.previousStageId,
          toIndex: 0,
        });
        this.logger.log(
          `follow-up: lead voltou, card ${card.id} saiu de "${NO_RETURN_STAGE}" (conv ${conversationId})`,
        );
      }
      await this.saveState(conversationId, { previousStageId: null });
    } catch (err: any) {
      this.logger.warn(
        `follow-up onInbound falhou (conv ${conversationId}): ${err?.message ?? err}`,
      );
    }
  }

  /** Pausa ou retoma o follow-up de uma conversa (botão do painel). */
  async setPaused(
    conversationId: string,
    organizationId: string,
    paused: boolean,
  ): Promise<FollowUpState> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { id: true, metadata: true },
    });
    if (!conversation) return {};
    if (paused) {
      await this.removeJob(this.readState(conversation.metadata).jobId);
      return this.saveState(conversationId, {
        paused: true,
        nextAt: null,
        jobId: null,
        stopReason: 'paused',
      });
    }
    await this.saveState(conversationId, { paused: false, stopReason: null });
    await this.schedule(conversationId);
    const fresh = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    return this.readState(fresh?.metadata);
  }
}
