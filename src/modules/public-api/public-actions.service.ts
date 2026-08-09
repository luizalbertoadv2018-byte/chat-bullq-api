import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AutomationTrigger,
  MessageContentType,
  MessageDirection,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OutboxService } from '../automations/outbox/outbox.service';
import { SalesRecoveryService } from '../sales-recovery/sales-recovery.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

const RECOVERY_STAGES = ['in_contact', 'follow_up', 'lost'] as const;
export type RecoveryStage = (typeof RECOVERY_STAGES)[number];

const RECOVERY_STAGE_LABEL: Record<RecoveryStage, string> = {
  in_contact: 'Em contato',
  follow_up: 'Follow-up',
  lost: 'Perdido',
};

/**
 * Lógica canônica das "ações fortes" expostas na API pública (chaves pk_).
 * É a fonte única de verdade consumida pelas tools do MCP — e reaproveitável
 * por qualquer outra porta de entrada. Tudo é escopado por organização.
 */
@Injectable()
export class PublicActionsService {
  private readonly logger = new Logger(PublicActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly recovery: SalesRecoveryService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  // ─── Ler conversa (leitura) ─────────────────────────────────

  async readConversation(orgId: string, conversationId: string, limit = 30) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: orgId },
      select: {
        id: true,
        status: true,
        subject: true,
        lastMessageAt: true,
        contact: { select: { name: true, phone: true, email: true } },
        tags: { select: { tag: { select: { name: true } } } },
      },
    });
    if (!conversation) {
      throw new NotFoundException('Conversa não encontrada nesta organização');
    }

    const messages = await this.prisma.message.findMany({
      where: { conversationId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        direction: true,
        type: true,
        content: true,
        senderName: true,
        createdAt: true,
      },
    });

    return {
      id: conversation.id,
      status: conversation.status,
      subject: conversation.subject,
      contact: conversation.contact,
      tags: conversation.tags.map((t) => t.tag.name),
      messages: messages.reverse().map((m) => ({
        direction: m.direction,
        type: m.type,
        text: this.extractText(m.content, m.type),
        sender: m.senderName,
        at: m.createdAt,
      })),
    };
  }

  private extractText(content: unknown, type: MessageContentType): string {
    if (content && typeof content === 'object' && 'text' in content) {
      const t = (content as { text?: unknown }).text;
      if (typeof t === 'string') return t;
    }
    return `[${type.toLowerCase()}]`;
  }

  // ─── Responder conversa (risco → dry-run + confirm) ─────────

  async replyPreview(orgId: string, conversationId: string, text: string) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new BadRequestException('Texto vazio');
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: orgId },
      select: { id: true, contact: { select: { name: true } } },
    });
    if (!conversation) {
      throw new NotFoundException('Conversa não encontrada nesta organização');
    }
    return {
      willExecute: false,
      action: `Enviar mensagem para "${conversation.contact?.name ?? 'contato'}"`,
      impact: 'high' as const,
      to: conversation.contact?.name ?? null,
      text: clean,
    };
  }

  async replyExecute(
    orgId: string,
    actorName: string | undefined,
    conversationId: string,
    text: string,
  ) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new BadRequestException('Texto vazio');

    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: orgId },
      select: { id: true, contactId: true, channelId: true },
    });
    if (!conversation) {
      throw new NotFoundException('Conversa não encontrada nesta organização');
    }

    const contactChannel = await this.prisma.contactChannel.findFirst({
      where: { contactId: conversation.contactId, channelId: conversation.channelId },
      select: { externalId: true },
    });
    if (!contactChannel?.externalId) {
      throw new BadRequestException('Contato sem external id neste canal — não é possível enviar');
    }

    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content: { text: clean },
        status: MessageStatus.QUEUED,
        senderName: actorName ?? 'Copilot',
        metadata: { via: 'public-api', copilot: true },
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    this.realtime.emitToChannel(conversation.channelId, 'message:new', {
      message,
      conversationId: conversation.id,
      contactId: conversation.contactId,
    });
    this.realtime.emitToConversation(conversation.id, 'message:new', { message });

    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId: conversation.channelId,
        contactExternalId: contactChannel.externalId,
        message: { type: MessageContentType.TEXT, content: { text: clean } },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(`API pública: reply enviada conv=${conversation.id} msg=${message.id}`);
    return { ok: true, messageId: message.id };
  }

  // ─── Disparo em massa (alto risco → dry-run + confirm) ──────

  private readonly MAX_BROADCAST = 500;

  private async resolveBroadcastTargets(
    orgId: string,
    filter: { tag?: string; conversationIds?: string[] },
  ) {
    const ids = Array.isArray(filter?.conversationIds)
      ? filter.conversationIds.filter((s) => typeof s === 'string' && s)
      : [];
    const tag = typeof filter?.tag === 'string' ? filter.tag.trim().toLowerCase() : '';

    if (ids.length === 0 && !tag) {
      throw new BadRequestException('Informe um filtro: "tag" ou "conversationIds".');
    }

    return this.prisma.conversation.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        ...(ids.length > 0 ? { id: { in: ids } } : {}),
        ...(tag ? { tags: { some: { tag: { name: tag } } } } : {}),
      },
      select: {
        id: true,
        contactId: true,
        channelId: true,
        contact: { select: { name: true } },
      },
    });
  }

  async broadcastPreview(
    orgId: string,
    filter: { tag?: string; conversationIds?: string[] },
    text: string,
  ) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new BadRequestException('Texto vazio');

    const targets = await this.resolveBroadcastTargets(orgId, filter);
    return {
      willExecute: false,
      action: `Disparar mensagem para ${targets.length} conversa(s)`,
      impact: 'critical' as const,
      count: targets.length,
      overLimit: targets.length > this.MAX_BROADCAST,
      limit: this.MAX_BROADCAST,
      sample: targets.slice(0, 10).map((t) => t.contact?.name ?? 'contato'),
      text: clean,
    };
  }

  async broadcastExecute(
    orgId: string,
    actorName: string | undefined,
    filter: { tag?: string; conversationIds?: string[] },
    text: string,
  ) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new BadRequestException('Texto vazio');

    const targets = await this.resolveBroadcastTargets(orgId, filter);
    if (targets.length === 0) {
      return { ok: true, enqueued: 0, skipped: 0 };
    }
    if (targets.length > this.MAX_BROADCAST) {
      throw new BadRequestException(
        `Muitos destinatários (${targets.length} > ${this.MAX_BROADCAST}). Refine o filtro.`,
      );
    }

    // Pré-carrega os externalId de todos os pares (contato, canal) numa query.
    const channels = await this.prisma.contactChannel.findMany({
      where: {
        OR: targets.map((t) => ({
          contactId: t.contactId,
          channelId: t.channelId,
        })),
      },
      select: { contactId: true, channelId: true, externalId: true },
    });
    const externalByPair = new Map(
      channels.map((c) => [`${c.contactId}:${c.channelId}`, c.externalId]),
    );

    let enqueued = 0;
    let skipped = 0;
    let i = 0;
    for (const t of targets) {
      const externalId = externalByPair.get(`${t.contactId}:${t.channelId}`);
      if (!externalId) {
        skipped++;
        continue;
      }

      const message = await this.prisma.message.create({
        data: {
          conversationId: t.id,
          direction: MessageDirection.OUTBOUND,
          type: MessageContentType.TEXT,
          content: { text: clean },
          status: MessageStatus.QUEUED,
          senderName: actorName ?? 'Copilot',
          metadata: { via: 'public-api', copilot: true, broadcast: true },
        },
      });
      await this.prisma.conversation.update({
        where: { id: t.id },
        data: { lastMessageAt: new Date() },
      });
      this.realtime.emitToConversation(t.id, 'message:new', { message });

      // Stagger: 1s entre cada envio pra não estourar rate limit do provider.
      await this.outboundQueue.add(
        'send-outbound',
        {
          messageId: message.id,
          channelId: t.channelId,
          contactExternalId: externalId,
          message: { type: MessageContentType.TEXT, content: { text: clean } },
        },
        {
          delay: i * 1000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      enqueued++;
      i++;
    }

    this.logger.log(
      `API pública: broadcast org=${orgId} enfileirado=${enqueued} pulado=${skipped}`,
    );
    return { ok: true, enqueued, skipped };
  }

  // ─── Tags (baixo risco) ─────────────────────────────────────

  async applyTags(
    orgId: string,
    actorId: string | undefined,
    conversationId: string,
    rawTags: string[],
  ): Promise<{ applied: string[] }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: orgId },
      select: { id: true, contactId: true, channelId: true },
    });
    if (!conversation) {
      throw new NotFoundException('Conversa não encontrada nesta organização');
    }

    const names = Array.from(
      new Set(
        (rawTags ?? [])
          .map((t) => String(t).trim().toLowerCase())
          .filter((t) => t.length > 0 && t.length <= 40),
      ),
    );
    if (names.length === 0) {
      throw new BadRequestException('Nenhum nome de tag válido');
    }

    const existing = await this.prisma.tag.findMany({
      where: { organizationId: orgId, name: { in: names } },
      select: { id: true, name: true },
    });
    const existingByName = new Map(existing.map((t) => [t.name, t.id]));
    const toCreate = names.filter((n) => !existingByName.has(n));

    const created = toCreate.length
      ? await this.prisma.$transaction(
          toCreate.map((name) =>
            this.prisma.tag.create({
              data: { organizationId: orgId, name },
              select: { id: true, name: true },
            }),
          ),
        )
      : [];

    const allTags = [...existing, ...created];

    for (const tag of allTags) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.conversationTag.create({
            data: { conversationId: conversation.id, tagId: tag.id },
          });
          await this.outbox.enqueue(tx, AutomationTrigger.TAG_ADDED, {
            organizationId: orgId,
            contactId: conversation.contactId,
            conversationId: conversation.id,
            channelId: conversation.channelId,
            actorId,
            tagId: tag.id,
            target: 'conversation',
          });
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue; // já aplicada — no-op
        }
        throw err;
      }
    }

    this.logger.log(`API pública: conv ${conversation.id} tagueada: ${names.join(', ')}`);
    return { applied: allTags.map((t) => t.name) };
  }

  // ─── Card de recuperação (risco → dry-run + confirm) ────────

  private assertStage(stageKey: string): RecoveryStage {
    if (!RECOVERY_STAGES.includes(stageKey as RecoveryStage)) {
      throw new BadRequestException(
        `stageKey inválido (use: ${RECOVERY_STAGES.join(', ')})`,
      );
    }
    return stageKey as RecoveryStage;
  }

  /** Preview (dry-run): valida escopo e descreve o que aconteceria. */
  async previewRecoveryMove(
    orgId: string,
    conversationId: string,
    stageKey: string,
  ) {
    const stage = this.assertStage(stageKey);
    const card = await this.prisma.card.findFirst({
      where: { conversationId, organizationId: orgId, status: 'OPEN' },
      select: { id: true, contact: { select: { name: true } } },
    });
    if (!card) {
      throw new NotFoundException(
        'Card aberto não encontrado para esta conversa nesta organização',
      );
    }
    return {
      willExecute: false,
      action: `Mover card de "${card.contact?.name ?? 'contato'}" → ${RECOVERY_STAGE_LABEL[stage]}`,
      impact: 'medium' as const,
      cardId: card.id,
      stageKey: stage,
    };
  }

  /** Execução real do movimento (após confirmação). */
  async moveRecoveryCard(orgId: string, conversationId: string, stageKey: string) {
    const stage = this.assertStage(stageKey);
    const card = await this.prisma.card.findFirst({
      where: { conversationId, organizationId: orgId, status: 'OPEN' },
      select: { id: true },
    });
    if (!card) {
      throw new NotFoundException('Card não encontrado nesta organização');
    }
    const result = await this.recovery.moveCardByConversation(conversationId, stage);
    this.logger.log(`API pública: card movido → ${stage} (conv=${conversationId})`);
    return { ...result, stageKey: stage };
  }
}
