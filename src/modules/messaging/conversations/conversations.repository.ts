import { Injectable } from '@nestjs/common';
import { ConversationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

export interface InboxFilters {
  organizationId: string;
  status?: ConversationStatus[];
  channelId?: string;
  /** Used by inbox views that pin multiple channels at once. Combines
   *  with accessibleChannelIds via intersection. */
  channelIds?: string[];
  /** Static list of conversation ids — used by inbox views built via
   *  bulk-action "create inbox from selection". When set, only these
   *  conversations match (still intersected with the other filters). */
  conversationIds?: string[];
  /** Filter by conversation kind: individual (1-on-1) vs group (WA group
   *  / IG group thread). Undefined = both. */
  kind?: 'INDIVIDUAL' | 'GROUP';
  /** Tag ids applied to the conversation OR its contact. ANY match. */
  tagIds?: string[];
  assignedToId?: string;
  search?: string;
  accessibleChannelIds?: string[];
  /**
   * Archive scope:
   *   - 'exclude' (default) — hide archived conversations from the list.
   *   - 'only'              — show only archived conversations.
   *   - 'any'               — ignore archive flag entirely.
   */
  archived?: 'exclude' | 'only' | 'any';
  /**
   * When true, only conversations with at least one inbound message newer
   * than the user's `lastReadAt` cursor (or with no read row at all) are
   * returned. Requires `currentUserId` — without it, the flag is a no-op.
   */
  unreadOnly?: boolean;
  /**
   * When true, only conversations marked `isStuck=true` pelo watchdog
   * (excederam `maxAttempts` sem resposta) são retornadas. Útil pro
   * filtro/widget do dashboard.
   */
  stuckOnly?: boolean;
  /** Filtra por origem do contato (contact.metadata.origem). */
  origem?: string;
  /** Período de atividade (lastMessageAt). ISO strings. */
  dateFrom?: string;
  dateTo?: string;
  /** Só conversas cuja ÚLTIMA mensagem é do cliente (INBOUND) — sem resposta. */
  unansweredOnly?: boolean;
  /** Só conversas paradas há mais de `inactiveHours` (default 24). */
  inactiveOnly?: boolean;
  inactiveHours?: number;
  /**
   * Modo Foco: todas as PENDING + as OPEN atribuídas ao usuário atual.
   * Requer currentUserId; sem ele é no-op.
   */
  focusMode?: boolean;
}

@Injectable()
export class ConversationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findInbox(
    filters: InboxFilters,
    skip: number,
    take: number,
    currentUserId?: string,
  ) {
    if (
      filters.accessibleChannelIds !== undefined &&
      filters.accessibleChannelIds.length === 0
    ) {
      return { conversations: [], total: 0 };
    }

    const where: Prisma.ConversationWhereInput = {
      organizationId: filters.organizationId,
      // Hide conversations from soft-deleted channels. ChannelsRepository.softDelete
      // already flags both the channel and its conversations as deleted, but the
      // inbox query never honoured that flag — so when a Zappfy instance was
      // removed and re-added (same provider token, new DB row), the old channel's
      // conversations kept showing up as phantom duplicates of the live ones.
      deletedAt: null,
    };

    // Archive scope. The default inbox hides archived conversations; an
    // explicit "Archived" view passes archived='only'; legacy callers that
    // don't care can pass 'any'.
    const archivedScope = filters.archived ?? 'exclude';
    if (archivedScope === 'exclude') where.isArchived = false;
    else if (archivedScope === 'only') where.isArchived = true;

    if (filters.status?.length) {
      where.status = filters.status.length === 1
        ? filters.status[0]
        : { in: filters.status };
    }
    // Resolve the effective channel filter:
    //   - filters.channelId  (single, from the topbar dropdown)
    //   - filters.channelIds (multiple, from an inbox view)
    //   - accessibleChannelIds (RBAC ceiling for AGENTs without ALL access)
    // Final set = (requested ∩ accessible). Empty set returns nothing.
    const requested =
      filters.channelIds && filters.channelIds.length > 0
        ? filters.channelIds
        : filters.channelId
          ? [filters.channelId]
          : null;

    if (filters.accessibleChannelIds !== undefined) {
      if (requested) {
        const allowed = requested.filter((id) =>
          filters.accessibleChannelIds!.includes(id),
        );
        if (allowed.length === 0) return { conversations: [], total: 0 };
        where.channelId = allowed.length === 1 ? allowed[0] : { in: allowed };
      } else {
        where.channelId = { in: filters.accessibleChannelIds };
      }
    } else if (requested) {
      where.channelId =
        requested.length === 1 ? requested[0] : { in: requested };
    }
    if (filters.conversationIds !== undefined) {
      if (filters.conversationIds.length === 0) {
        return { conversations: [], total: 0 };
      }
      where.id = { in: filters.conversationIds };
    }
    if (filters.kind === 'INDIVIDUAL') where.isGroup = false;
    else if (filters.kind === 'GROUP') where.isGroup = true;
    if (filters.tagIds && filters.tagIds.length > 0) {
      // Match conversations that carry ANY of the requested tags. Includes
      // tags applied directly on the conversation OR on its contact —
      // operators tag both ways and expect the inbox to surface either.
      where.OR = [
        ...(where.OR ?? []) as any[],
        { tags: { some: { tagId: { in: filters.tagIds } } } },
        { contact: { tags: { some: { tagId: { in: filters.tagIds } } } } },
      ];
    }
    if (filters.assignedToId) where.assignedToId = filters.assignedToId;
    if (filters.stuckOnly) where.isStuck = true;
    if (filters.search) {
      where.OR = [
        { contact: { name: { contains: filters.search, mode: 'insensitive' } } },
        { contact: { phone: { contains: filters.search } } },
        { protocol: { contains: filters.search } },
      ];
    }

    // Origem do contato (contact.metadata.origem === valor).
    if (filters.origem) {
      where.contact = {
        ...((where.contact as Prisma.ContactWhereInput) ?? {}),
        metadata: { path: ['origem'], equals: filters.origem },
      };
    }

    // Período de atividade + inatividade — ambos operam em lastMessageAt.
    const lastMsg: Prisma.DateTimeNullableFilter = {};
    if (filters.dateFrom) lastMsg.gte = new Date(filters.dateFrom);
    if (filters.dateTo) lastMsg.lte = new Date(filters.dateTo);
    if (filters.inactiveOnly) {
      const hours = filters.inactiveHours && filters.inactiveHours > 0
        ? filters.inactiveHours
        : 24;
      const cutoff = new Date(Date.now() - hours * 3_600_000);
      // Combina com o período: pega o teto mais restritivo.
      if (!lastMsg.lte || (lastMsg.lte as Date) > cutoff) lastMsg.lte = cutoff;
    }
    if (lastMsg.gte || lastMsg.lte) where.lastMessageAt = lastMsg;

    // Modo Foco: PENDING (de todos) + OPEN atribuídas a mim. Usa AND pra não
    // colidir com o OR de tags/busca.
    if (filters.focusMode && currentUserId) {
      (where.AND ??= [] as Prisma.ConversationWhereInput[]);
      (where.AND as Prisma.ConversationWhereInput[]).push({
        OR: [
          { status: ConversationStatus.PENDING },
          { status: ConversationStatus.OPEN, assignedToId: currentUserId },
        ],
      });
    }

    // "Unread only" filter — materialize the exact set of conversation ids
    // that have at least one INBOUND message newer than this user's
    // ConversationRead.lastReadAt (or no read row at all). Doing this in SQL
    // lets the main paginated query filter by `id IN (...)` so skip/take and
    // the count() are honest. Previously this ran post-paging in JS, which
    // truncated each page to the unread subset of those 30 rows and made
    // pagination terminate early — unread conversations sitting past row 30
    // never surfaced.
    // Uma inbound só conta como não lida se for mais nova que (a) o cursor
    // de leitura DESTE usuário e (b) a última OUTBOUND da conversa — de
    // QUALQUER pessoa (operador, IA, ou echo do celular sem sender). Inbox
    // de atendimento é compartilhado: se alguém da equipe já respondeu, a
    // conversa não está mais pendente pra ninguém. Sem o critério (b),
    // conversas respondidas pela colega continuavam em "não lidas" de todo
    // o resto do time pra sempre (ConversationRead é per-user).
    // Trade-off consciente: "marcar como não lida" deixa de surtir efeito
    // quando a última mensagem da conversa é uma resposta da equipe.
    if (filters.unreadOnly && currentUserId) {
      const rows = await this.prisma.$queryRaw<{ conversation_id: string }[]>`
        SELECT DISTINCT m.conversation_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        LEFT JOIN conversation_reads cr
          ON cr.conversation_id = m.conversation_id
          AND cr.user_id = ${currentUserId}
        LEFT JOIN (
          SELECT mo.conversation_id, MAX(mo.created_at) AS last_outbound_at
          FROM messages mo
          JOIN conversations co ON co.id = mo.conversation_id
          WHERE co.organization_id = ${filters.organizationId}
            AND mo.direction = 'OUTBOUND'
          GROUP BY mo.conversation_id
        ) lo ON lo.conversation_id = m.conversation_id
        WHERE c.organization_id = ${filters.organizationId}
          AND c.deleted_at IS NULL
          AND m.direction = 'INBOUND'
          AND (cr.last_read_at IS NULL OR m.created_at > cr.last_read_at)
          AND (lo.last_outbound_at IS NULL OR m.created_at > lo.last_outbound_at)
      `;
      const unreadIds = rows.map((r) => r.conversation_id);
      if (unreadIds.length === 0) return { conversations: [], total: 0 };
      // Intersect with any pre-existing id constraint (from conversationIds).
      if (
        where.id &&
        typeof where.id === 'object' &&
        'in' in where.id &&
        Array.isArray((where.id as { in: string[] }).in)
      ) {
        const existing = (where.id as { in: string[] }).in;
        const intersect = existing.filter((id) => unreadIds.includes(id));
        if (intersect.length === 0) return { conversations: [], total: 0 };
        where.id = { in: intersect };
      } else {
        where.id = { in: unreadIds };
      }
    }

    // "Sem resposta" — conversas cuja ÚLTIMA mensagem é do cliente (INBOUND),
    // ou seja, ninguém respondeu ainda. Materializa os ids e intersecta com
    // o where.id (mesmo padrão do unread).
    if (filters.unansweredOnly) {
      const rows = await this.prisma.$queryRaw<{ conversation_id: string }[]>`
        SELECT c.id AS conversation_id
        FROM conversations c
        JOIN LATERAL (
          SELECT m.direction
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) last ON true
        WHERE c.organization_id = ${filters.organizationId}
          AND c.deleted_at IS NULL
          AND last.direction = 'INBOUND'
      `;
      const ids = rows.map((r) => r.conversation_id);
      if (ids.length === 0) return { conversations: [], total: 0 };
      if (
        where.id &&
        typeof where.id === 'object' &&
        'in' in where.id &&
        Array.isArray((where.id as { in: string[] }).in)
      ) {
        const existing = (where.id as { in: string[] }).in;
        const intersect = existing.filter((id) => ids.includes(id));
        if (intersect.length === 0) return { conversations: [], total: 0 };
        where.id = { in: intersect };
      } else {
        where.id = { in: ids };
      }
    }

    const [conversations, total] = await this.prisma.$transaction([
      this.prisma.conversation.findMany({
        where,
        include: {
          contact: {
            select: {
              id: true,
              name: true,
              phone: true,
              avatarUrl: true,
              blocked: true,
              tags: { include: { tag: true } },
              // Canais do contato → deriva o JID do grupo p/ anexar o Projeto.
              channels: { select: { channelId: true, externalId: true } },
            },
          },
          channel: {
            select: { id: true, type: true, name: true },
          },
          assignedTo: {
            select: { id: true, name: true, avatarUrl: true },
          },
          situacao: { select: { id: true, name: true, color: true } },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              type: true,
              content: true,
              direction: true,
              createdAt: true,
            },
          },
          tags: { include: { tag: true } },
          _count: { select: { messages: true } },
        },
        orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        skip,
        take,
      }),
      this.prisma.conversation.count({ where }),
    ]);

    // Per-user unread counters. Caller passes currentUserId; the user's
    // ConversationRead row holds the lastReadAt cursor and we count INBOUND
    // messages newer than that cursor. Conversations the user never opened
    // get every inbound message counted as unread.
    const enriched = currentUserId
      ? await this.attachUnreadCounts(conversations, currentUserId)
      : conversations.map((c) => ({ ...c, unreadCount: 0 }));

    return { conversations: enriched, total };
  }

  private async attachUnreadCounts<
    T extends { id: string; createdAt: Date },
  >(conversations: T[], userId: string): Promise<Array<T & { unreadCount: number }>> {
    if (conversations.length === 0) return [];
    const ids = conversations.map((c) => c.id);
    const [reads, lastOutbounds] = await Promise.all([
      this.prisma.conversationRead.findMany({
        where: { userId, conversationId: { in: ids } },
        select: { conversationId: true, lastReadAt: true },
      }),
      this.prisma.message.groupBy({
        by: ['conversationId'],
        where: { conversationId: { in: ids }, direction: 'OUTBOUND' },
        _max: { createdAt: true },
      }),
    ]);
    const readByConv = new Map(
      reads.map((r) => [r.conversationId, r.lastReadAt]),
    );
    const outByConv = new Map(
      lastOutbounds.map((r) => [r.conversationId, r._max.createdAt]),
    );

    // Run the counts in parallel — bounded by `take` (≤ 30 typically).
    const counts = await Promise.all(
      conversations.map((c) => {
        // Mesmo critério do filtro unreadOnly acima: o badge conta inbound
        // mais novas que o MAIOR entre o cursor de leitura do usuário e a
        // última resposta da equipe — senão badge e filtro divergem.
        const read = readByConv.get(c.id);
        const out = outByConv.get(c.id);
        const cursor =
          read && out ? (read > out ? read : out) : (read ?? out);
        return this.prisma.message.count({
          where: {
            conversationId: c.id,
            direction: 'INBOUND',
            ...(cursor ? { createdAt: { gt: cursor } } : {}),
          },
        });
      }),
    );

    return conversations.map((c, i) => ({ ...c, unreadCount: counts[i] }));
  }

  /** Marks a conversation as read for a user up to the given message (or now). */
  async markAsRead(
    userId: string,
    conversationId: string,
    lastReadMessageId?: string,
  ) {
    return this.prisma.conversationRead.upsert({
      where: {
        userId_conversationId: { userId, conversationId },
      },
      create: {
        userId,
        conversationId,
        lastReadMessageId: lastReadMessageId ?? null,
        lastReadAt: new Date(),
      },
      update: {
        lastReadMessageId: lastReadMessageId ?? null,
        lastReadAt: new Date(),
      },
    });
  }

  /**
   * Marks a conversation as unread for a user. Slack/Gmail-style semantics:
   * we don't reset the entire history — we push `lastReadAt` to right before
   * the most recent INBOUND message so the badge shows ≥ 1 unread.
   * If there's no inbound message yet, drop the read row entirely.
   */
  async markAsUnread(userId: string, conversationId: string) {
    const lastInbound = await this.prisma.message.findFirst({
      where: { conversationId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });

    if (!lastInbound) {
      await this.prisma.conversationRead.deleteMany({
        where: { userId, conversationId },
      });
      return { lastReadAt: null as Date | null, unreadCount: 0 };
    }

    // 1ms before the last inbound — the count query uses `gt`, so this
    // makes that single message (and any later ones) count as unread.
    const newLastReadAt = new Date(lastInbound.createdAt.getTime() - 1);
    await this.prisma.conversationRead.upsert({
      where: { userId_conversationId: { userId, conversationId } },
      create: {
        userId,
        conversationId,
        lastReadMessageId: null,
        lastReadAt: newLastReadAt,
      },
      update: { lastReadMessageId: null, lastReadAt: newLastReadAt },
    });

    const unreadCount = await this.prisma.message.count({
      where: {
        conversationId,
        direction: 'INBOUND',
        createdAt: { gt: newLastReadAt },
      },
    });

    return { lastReadAt: newLastReadAt, unreadCount };
  }

  async findById(id: string) {
    return this.prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: { include: { channels: true, tags: { include: { tag: true } } } },
        channel: true,
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
        department: true,
        situacao: true,
        tags: { include: { tag: true } },
        auditLogs: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
  }

  async update(id: string, data: Prisma.ConversationUpdateInput) {
    return this.prisma.conversation.update({ where: { id }, data });
  }

  async countByStatus(organizationId: string, accessibleChannelIds?: string[]) {
    if (accessibleChannelIds !== undefined && accessibleChannelIds.length === 0) {
      return {} as Record<string, number>;
    }
    const counts = await this.prisma.conversation.groupBy({
      by: ['status'],
      where: {
        organizationId,
        deletedAt: null,
        ...(accessibleChannelIds !== undefined
          ? { channelId: { in: accessibleChannelIds } }
          : {}),
      },
      _count: true,
    });
    return counts.reduce(
      (acc, c) => ({ ...acc, [c.status]: c._count }),
      {} as Record<string, number>,
    );
  }
}
