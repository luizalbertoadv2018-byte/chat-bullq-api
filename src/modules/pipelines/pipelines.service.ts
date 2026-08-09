import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CardStatus, PipelineStageType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  CreateCardDto,
  CreatePipelineDto,
  MoveCardDto,
  UpdateCardDto,
  UpdatePipelineDto,
  UpsertStageDto,
} from './dto/pipeline.dto';

const DEFAULT_STAGES: UpsertStageDto[] = [
  { name: 'Novo', color: 'zinc', type: 'NORMAL', order: 0 },
  { name: 'Em qualificação', color: 'blue', type: 'NORMAL', order: 1 },
  { name: 'Proposta', color: 'amber', type: 'NORMAL', order: 2 },
  { name: 'Ganho', color: 'green', type: 'WON', order: 3 },
  { name: 'Perdido', color: 'red', type: 'LOST', order: 4 },
];

@Injectable()
export class PipelinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // ─── Pipelines ─────────────────────────────────

  async listPipelines(organizationId: string) {
    return this.prisma.pipeline.findMany({
      where: { organizationId, archived: false },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      include: {
        stages: { orderBy: { order: 'asc' } },
        _count: { select: { cards: true } },
      },
    });
  }

  async getBoard(pipelineId: string, organizationId: string) {
    const pipeline = await this.assertPipeline(pipelineId, organizationId);
    const [stages, cards] = await this.prisma.$transaction([
      this.prisma.pipelineStage.findMany({
        where: { pipelineId },
        orderBy: { order: 'asc' },
      }),
      this.prisma.card.findMany({
        where: { pipelineId },
        orderBy: { order: 'asc' },
        include: {
          contact: { select: { id: true, name: true, phone: true, avatarUrl: true } },
          assignedTo: { select: { id: true, name: true, avatarUrl: true } },
          // Channel comes via the linked conversation — the kanban card UI
          // surfaces the icon (Zappfy/Meta/Instagram) so the operator can
          // tell at a glance where the conversation lives without opening it.
          conversation: {
            select: {
              id: true,
              channelId: true,
              channel: { select: { id: true, type: true, name: true } },
            },
          },
        },
      }),
    ]);

    const cardsByStage: Record<string, typeof cards> = {};
    for (const s of stages) cardsByStage[s.id] = [];
    for (const c of cards) {
      (cardsByStage[c.stageId] ||= []).push(c);
    }

    return { pipeline, stages, cards: cardsByStage };
  }

  async createPipeline(organizationId: string, dto: CreatePipelineDto) {
    const stagesIn = dto.stages?.length ? dto.stages : DEFAULT_STAGES;

    const max = await this.prisma.pipeline.findFirst({
      where: { organizationId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const nextOrder = (max?.order ?? -1) + 1;

    return this.prisma.$transaction(async (tx) => {
      // Only one default per org — if requested, demote the others.
      if (dto.isDefault) {
        await tx.pipeline.updateMany({
          where: { organizationId, isDefault: true },
          data: { isDefault: false },
        });
      }

      const pipeline = await tx.pipeline.create({
        data: {
          organizationId,
          name: dto.name,
          description: dto.description,
          icon: dto.icon,
          color: dto.color,
          isDefault: dto.isDefault ?? false,
          order: nextOrder,
          stages: {
            create: stagesIn.map((s, i) => ({
              name: s.name,
              color: s.color,
              type: (s.type ?? 'NORMAL') as PipelineStageType,
              order: s.order ?? i,
            })),
          },
        },
        include: { stages: { orderBy: { order: 'asc' } } },
      });

      return pipeline;
    });
  }

  async updatePipeline(
    id: string,
    organizationId: string,
    dto: UpdatePipelineDto,
  ) {
    await this.assertPipeline(id, organizationId);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.pipeline.updateMany({
          where: { organizationId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.pipeline.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
          ...(dto.archived !== undefined ? { archived: dto.archived } : {}),
          ...(dto.order !== undefined ? { order: dto.order } : {}),
        },
      });
    });
  }

  async removePipeline(id: string, organizationId: string) {
    await this.assertPipeline(id, organizationId);
    await this.prisma.pipeline.delete({ where: { id } });
  }

  // ─── Stages ────────────────────────────────────

  async upsertStages(
    pipelineId: string,
    organizationId: string,
    stages: UpsertStageDto[],
  ) {
    await this.assertPipeline(pipelineId, organizationId);

    return this.prisma.$transaction(async (tx) => {
      // Existing ids that still appear in the new list — keep them.
      const keepIds = new Set(stages.filter((s) => s.id).map((s) => s.id!));

      // Delete stages that disappeared. If they have cards, refuse — operator
      // must move/close cards first.
      const orphans = await tx.pipelineStage.findMany({
        where: {
          pipelineId,
          ...(keepIds.size > 0 ? { id: { notIn: Array.from(keepIds) } } : {}),
        },
        include: { _count: { select: { cards: true } } },
      });
      for (const o of orphans) {
        if (o._count.cards > 0) {
          throw new BadRequestException(
            `Stage "${o.name}" tem cards e não pode ser deletada — mova-os primeiro.`,
          );
        }
      }
      if (orphans.length > 0) {
        await tx.pipelineStage.deleteMany({
          where: { id: { in: orphans.map((o) => o.id) } },
        });
      }

      // Upsert each remaining stage.
      const upserts = stages.map((s, i) => {
        const data = {
          name: s.name,
          color: s.color ?? null,
          type: (s.type ?? 'NORMAL') as PipelineStageType,
          order: s.order ?? i,
        };
        return s.id
          ? tx.pipelineStage.update({ where: { id: s.id }, data })
          : tx.pipelineStage.create({
              data: { pipelineId, ...data },
            });
      });
      await Promise.all(upserts);

      return tx.pipelineStage.findMany({
        where: { pipelineId },
        orderBy: { order: 'asc' },
      });
    });
  }

  // ─── Cards ─────────────────────────────────────

  async createCard(
    pipelineId: string,
    organizationId: string,
    dto: CreateCardDto,
  ) {
    await this.assertPipeline(pipelineId, organizationId);

    // Cards represent conversations entering the pipeline. If the same
    // conversation is already in this pipeline (any stage), reject — the
    // operator should move/edit the existing card instead of duplicating.
    if (dto.conversationId) {
      const existing = await this.prisma.card.findFirst({
        where: { pipelineId, conversationId: dto.conversationId },
        select: { id: true, stageId: true },
      });
      if (existing) {
        throw new BadRequestException(
          `Essa conversa já está no pipeline (card ${existing.id}). Mova-o em vez de duplicar.`,
        );
      }
    }

    // If conversationId provided, hydrate title/contactId from the conv
    // so the operator doesn't need to retype the contact name.
    if (dto.conversationId) {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: dto.conversationId },
        select: {
          id: true,
          organizationId: true,
          contactId: true,
          contact: { select: { name: true, phone: true } },
        },
      });
      if (!conv || conv.organizationId !== organizationId) {
        throw new BadRequestException('conversationId inválido');
      }
      if (!dto.title?.trim()) {
        dto.title = conv.contact.name || conv.contact.phone || 'Sem nome';
      }
      if (!dto.contactId) {
        dto.contactId = conv.contactId;
      }
    }

    // Resolve stage: explicit → use it; else first stage of the pipeline.
    let stageId = dto.stageId;
    if (!stageId) {
      const first = await this.prisma.pipelineStage.findFirst({
        where: { pipelineId },
        orderBy: { order: 'asc' },
      });
      if (!first) throw new BadRequestException('Pipeline sem stages');
      stageId = first.id;
    } else {
      const stage = await this.prisma.pipelineStage.findUnique({
        where: { id: stageId },
      });
      if (!stage || stage.pipelineId !== pipelineId) {
        throw new BadRequestException('stageId inválido pra esse pipeline');
      }
    }

    const max = await this.prisma.card.findFirst({
      where: { pipelineId, stageId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const nextOrder = (max?.order ?? -1) + 1;

    if (!dto.title?.trim()) {
      throw new BadRequestException(
        'title é obrigatório (ou vincule uma conversationId pra derivar)',
      );
    }

    const card = await this.prisma.card.create({
      data: {
        organizationId,
        pipelineId,
        stageId,
        title: dto.title!,
        description: dto.description,
        value: dto.value as any,
        currency: dto.currency ?? 'BRL',
        contactId: dto.contactId ?? null,
        conversationId: dto.conversationId ?? null,
        assignedToId: dto.assignedToId ?? null,
        order: nextOrder,
      },
      include: {
        contact: { select: { id: true, name: true, phone: true, avatarUrl: true } },
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    this.realtime.emitToOrg(organizationId, 'card:created', { card });
    return card;
  }

  async updateCard(
    cardId: string,
    organizationId: string,
    dto: UpdateCardDto,
  ) {
    const card = await this.prisma.card.findUnique({ where: { id: cardId } });
    if (!card || card.organizationId !== organizationId) {
      throw new NotFoundException('Card not found');
    }

    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.value !== undefined ? { value: dto.value as any } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.contactId !== undefined
          ? { contactId: dto.contactId }
          : {}),
        ...(dto.conversationId !== undefined
          ? { conversationId: dto.conversationId }
          : {}),
        ...(dto.assignedToId !== undefined
          ? { assignedToId: dto.assignedToId }
          : {}),
        ...(dto.closedReason !== undefined
          ? { closedReason: dto.closedReason }
          : {}),
      },
      include: {
        contact: { select: { id: true, name: true, phone: true, avatarUrl: true } },
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    this.realtime.emitToOrg(organizationId, 'card:updated', { card: updated });
    return updated;
  }

  async removeCard(cardId: string, organizationId: string) {
    const card = await this.prisma.card.findUnique({ where: { id: cardId } });
    if (!card || card.organizationId !== organizationId) {
      throw new NotFoundException('Card not found');
    }
    await this.prisma.card.delete({ where: { id: cardId } });
    this.realtime.emitToOrg(organizationId, 'card:deleted', {
      cardId,
      pipelineId: card.pipelineId,
    });
  }

  /**
   * Atomic drag-drop: pulls the card out of its source stage, shifts the
   * other source siblings up, makes room in the target stage at toIndex,
   * inserts the card. Updates `status` + `closedAt` if the target stage
   * is a WON/LOST terminal.
   */
  async moveCard(
    cardId: string,
    organizationId: string,
    dto: MoveCardDto,
  ) {
    const card = await this.prisma.card.findUnique({ where: { id: cardId } });
    if (!card || card.organizationId !== organizationId) {
      throw new NotFoundException('Card not found');
    }
    const targetStage = await this.prisma.pipelineStage.findUnique({
      where: { id: dto.toStageId },
    });
    if (!targetStage || targetStage.pipelineId !== card.pipelineId) {
      throw new BadRequestException('toStageId fora desse pipeline');
    }

    const fromStageId = card.stageId;
    const fromIndex = card.order;
    const sameStage = fromStageId === dto.toStageId;

    let newStatus: CardStatus = card.status;
    let newClosedAt = card.closedAt;
    if (targetStage.type === 'WON') {
      newStatus = CardStatus.WON;
      newClosedAt = newClosedAt ?? new Date();
    } else if (targetStage.type === 'LOST') {
      newStatus = CardStatus.LOST;
      newClosedAt = newClosedAt ?? new Date();
    } else {
      newStatus = CardStatus.OPEN;
      newClosedAt = null;
    }

    await this.prisma.$transaction(async (tx) => {
      if (sameStage) {
        // Reorder within the same column.
        if (fromIndex === dto.toIndex) return;
        if (fromIndex < dto.toIndex) {
          await tx.card.updateMany({
            where: {
              pipelineId: card.pipelineId,
              stageId: fromStageId,
              order: { gt: fromIndex, lte: dto.toIndex },
            },
            data: { order: { decrement: 1 } },
          });
        } else {
          await tx.card.updateMany({
            where: {
              pipelineId: card.pipelineId,
              stageId: fromStageId,
              order: { gte: dto.toIndex, lt: fromIndex },
            },
            data: { order: { increment: 1 } },
          });
        }
      } else {
        // Close the gap in source stage.
        await tx.card.updateMany({
          where: {
            pipelineId: card.pipelineId,
            stageId: fromStageId,
            order: { gt: fromIndex },
          },
          data: { order: { decrement: 1 } },
        });
        // Open a slot in target stage.
        await tx.card.updateMany({
          where: {
            pipelineId: card.pipelineId,
            stageId: dto.toStageId,
            order: { gte: dto.toIndex },
          },
          data: { order: { increment: 1 } },
        });
      }

      await tx.card.update({
        where: { id: cardId },
        data: {
          stageId: dto.toStageId,
          order: dto.toIndex,
          status: newStatus,
          closedAt: newClosedAt,
        },
      });
    });

    this.realtime.emitToOrg(organizationId, 'card:moved', {
      cardId,
      pipelineId: card.pipelineId,
      fromStageId,
      toStageId: dto.toStageId,
      toIndex: dto.toIndex,
      status: newStatus,
    });

    return this.prisma.card.findUnique({
      where: { id: cardId },
      include: {
        contact: { select: { id: true, name: true, phone: true, avatarUrl: true } },
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  /**
   * Lista todos os cards (pipelines) em que uma conversa está. Usado pela
   * UI da inbox pra mostrar/editar/remover a conversa de pipelines direto
   * do header da conversa (sem precisar abrir o kanban).
   */
  async listCardsByConversation(
    conversationId: string,
    organizationId: string,
  ) {
    return this.prisma.card.findMany({
      where: { conversationId, organizationId },
      orderBy: { createdAt: 'asc' },
      include: {
        pipeline: {
          select: {
            id: true,
            name: true,
            color: true,
            icon: true,
            archived: true,
          },
        },
        stage: {
          select: { id: true, name: true, color: true, type: true, order: true },
        },
      },
    });
  }

  /**
   * Métricas de gestão do funil (dashboard): visão geral + por pipeline
   * (conversão, ganhos/perdas, tempo médio até fechar, distribuição por
   * estágio) + leads criados por dia no período.
   */
  async getMetrics(organizationId: string, days = 30) {
    const clampedDays = Math.min(Math.max(days, 1), 180);
    const since = new Date(Date.now() - clampedDays * 86_400_000);

    const pipelines = await this.prisma.pipeline.findMany({
      where: { organizationId, archived: false },
      orderBy: { order: 'asc' },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    const cards = await this.prisma.card.findMany({
      where: { organizationId },
      select: {
        pipelineId: true,
        stageId: true,
        status: true,
        createdAt: true,
        closedAt: true,
      },
    });

    const dayMs = 86_400_000;
    const perPipeline = pipelines.map((p) => {
      const pc = cards.filter((c) => c.pipelineId === p.id);
      const won = pc.filter((c) => c.status === 'WON').length;
      const lost = pc.filter((c) => c.status === 'LOST').length;
      const open = pc.filter((c) => c.status === 'OPEN').length;
      const decided = won + lost;
      const closed = pc.filter((c) => c.closedAt);
      const avgDaysToClose = closed.length
        ? Math.round(
            (closed.reduce(
              (s, c) => s + (c.closedAt!.getTime() - c.createdAt.getTime()),
              0,
            ) /
              closed.length /
              dayMs) *
              10,
          ) / 10
        : null;
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        total: pc.length,
        open,
        won,
        lost,
        conversao: decided ? Math.round((won / decided) * 100) : null,
        avgDaysToClose,
        stages: p.stages.map((s) => ({
          name: s.name,
          type: s.type,
          count: pc.filter((c) => c.stageId === s.id).length,
        })),
      };
    });

    const totalWon = cards.filter((c) => c.status === 'WON').length;
    const totalLost = cards.filter((c) => c.status === 'LOST').length;
    const totalOpen = cards.filter((c) => c.status === 'OPEN').length;
    const decidedAll = totalWon + totalLost;

    // Leads (cards) criados por dia no período.
    const byDay = new Map<string, number>();
    for (let i = 0; i < clampedDays; i++) {
      const d = new Date(Date.now() - (clampedDays - 1 - i) * dayMs);
      byDay.set(d.toISOString().slice(0, 10), 0);
    }
    for (const c of cards) {
      if (c.createdAt >= since) {
        const key = c.createdAt.toISOString().slice(0, 10);
        if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + 1);
      }
    }
    const leadsPorDia = Array.from(byDay.entries()).map(([date, count]) => ({
      date,
      count,
    }));
    const leadsNoPeriodo = leadsPorDia.reduce((s, d) => s + d.count, 0);

    return {
      overview: {
        totalLeads: cards.length,
        ativos: totalOpen,
        ganhos: totalWon,
        perdidos: totalLost,
        conversao: decidedAll ? Math.round((totalWon / decidedAll) * 100) : null,
        leadsNoPeriodo,
        periodoDias: clampedDays,
      },
      pipelines: perPipeline,
      leadsPorDia,
    };
  }

  /** Normaliza nome de estágio p/ casar sem acento/caixa. */
  private normalizeStageName(s: string): string {
    return Array.from((s ?? '').normalize('NFD'))
      .filter((ch) => {
        const c = ch.codePointAt(0) ?? 0;
        return c < 0x0300 || c > 0x036f;
      })
      .join('')
      .toLowerCase()
      .trim();
  }

  /**
   * Move os cards que casam com `where` para o estágio cujo nome bate com
   * `stageName` (sem acento/caixa; exato, senão "contém"), no topo da coluna.
   * Núcleo do fechamento de ciclo (assinou → "Contrato Assinado") e da tool
   * da IA (qualifica/desqualifica). Idempotente: se já está lá, pula.
   */
  private async moveCardsToStage(
    where: { organizationId: string; conversationId?: string; contactId?: string },
    stageName: string,
  ): Promise<{ moved: number; stage: string | null }> {
    const target = this.normalizeStageName(stageName);
    if (!target) return { moved: 0, stage: null };
    const cards = await this.prisma.card.findMany({
      where,
      select: { id: true, pipelineId: true, stageId: true },
    });
    let moved = 0;
    let stageLabel: string | null = null;
    for (const card of cards) {
      const stages = await this.prisma.pipelineStage.findMany({
        where: { pipelineId: card.pipelineId },
        select: { id: true, name: true },
      });
      let stage = stages.find((s) => this.normalizeStageName(s.name) === target);
      if (!stage) {
        stage = stages.find((s) => this.normalizeStageName(s.name).includes(target));
      }
      if (!stage || stage.id === card.stageId) continue;
      try {
        await this.moveCard(card.id, where.organizationId, {
          toStageId: stage.id,
          toIndex: 0,
        });
        moved++;
        stageLabel = stage.name;
      } catch {
        /* ignora — não bloqueia o fluxo */
      }
    }
    return { moved, stage: stageLabel };
  }

  /** Move os cards de uma CONVERSA para o estágio nomeado (tool da IA). */
  async moveConversationCardsToStage(
    conversationId: string,
    organizationId: string,
    stageName: string,
  ) {
    return this.moveCardsToStage({ conversationId, organizationId }, stageName);
  }

  /** Move os cards de um CONTATO para o estágio nomeado (fechamento de ciclo). */
  async moveContactCardsToStage(
    contactId: string,
    organizationId: string,
    stageName: string,
  ) {
    return this.moveCardsToStage({ contactId, organizationId }, stageName);
  }

  // ─── helpers ───────────────────────────────────

  private async assertPipeline(id: string, organizationId: string) {
    const p = await this.prisma.pipeline.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Pipeline not found');
    if (p.organizationId !== organizationId) throw new ForbiddenException();
    return p;
  }
}
