import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OwnerAlertService } from '../owner-alerts/owner-alert.service';
import {
  AUDIT_FOLLOW_UP_EXHAUSTED,
  AUDIT_FOLLOW_UP_SENT,
  FollowUpSettings,
  humanizeSilence,
  isBasicDocument,
} from './follow-up.rules';

const MAX_LINES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resumo diário para a equipe, no grupo de avisos: o que depende de gente.
 * A IA não escreve em conversa que um humano assumiu; em troca, quem assumiu
 * é lembrado aqui de quem está esperando.
 */
@Injectable()
export class FollowUpSummaryService {
  private readonly logger = new Logger(FollowUpSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerAlerts: OwnerAlertService,
  ) {}

  /** Envia o resumo de toda organização com follow-up ligado. */
  async sendAll(): Promise<{ sent: number }> {
    const orgs = await this.prisma.organization.findMany({
      select: { id: true, settings: true, aiTimezone: true },
    });
    let sent = 0;
    for (const org of orgs) {
      const settings = (org.settings ?? {}) as Record<string, any>;
      const fu = settings.followUp as FollowUpSettings | undefined;
      const on =
        fu?.summary === true || (fu?.enabled === true && fu.summary !== false);
      if (!on) continue;
      if (await this.sendFor(org.id)) sent++;
    }
    return { sent };
  }

  /** Monta e envia o resumo de uma organização. `false` se não havia o que dizer. */
  async sendFor(organizationId: string): Promise<boolean> {
    try {
      const text = await this.build(organizationId);
      if (!text) return false;
      await this.ownerAlerts.notify(organizationId, text);
      return true;
    } catch (err: any) {
      this.logger.warn(
        `resumo diário falhou (org ${organizationId}): ${err?.message ?? err}`,
      );
      return false;
    }
  }

  async build(organizationId: string): Promise<string | null> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true, aiTimezone: true },
    });
    const settings = (org?.settings ?? {}) as Record<string, any>;
    // Mesmo canal dos avisos (o número do nicho); sem ele, todos os canais.
    const channelId: string | undefined = settings.ownerAlerts?.channelId;
    const channelCond = channelId
      ? Prisma.sql`AND c.channel_id = ${channelId}`
      : Prisma.empty;
    const now = Date.now();

    // 1) IA desligada e a última mensagem é do cliente: alguém precisa responder.
    const waiting = await this.prisma.$queryRaw<
      { name: string | null; phone: string | null; assignee: string | null; since: Date }[]
    >`
      SELECT ct.name, ct.phone, u.name AS assignee, lm.created_at AS since
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN users u ON u.id = c.assigned_to_id
      JOIN LATERAL (
        SELECT m.direction, m.created_at FROM messages m
        WHERE m.conversation_id = c.id
          AND NOT (m.type = 'REACTION' AND m.direction = 'OUTBOUND')
        ORDER BY m.created_at DESC LIMIT 1
      ) lm ON true
      WHERE c.organization_id = ${organizationId} ${channelCond}
        AND c.deleted_at IS NULL AND c.is_group = false AND c.is_archived = false
        AND c.status <> 'CLOSED' AND c.ai_enabled = false
        AND lm.direction = 'INBOUND'
        AND lm.created_at > now() - interval '14 days'
      ORDER BY lm.created_at ASC
    `;

    // 2) Assinados com documento básico pendente.
    const signed = await this.prisma.$queryRaw<
      { name: string | null; pipeline_id: string; metadata: any }[]
    >`
      SELECT DISTINCT ON (ct.id) ct.name, ca.pipeline_id, ct.metadata
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      JOIN cards ca ON ca.conversation_id = c.id
      WHERE c.organization_id = ${organizationId} ${channelCond}
        AND c.deleted_at IS NULL AND c.is_group = false
        AND ct.metadata->>'tramitacaoReleased' = 'true'
      ORDER BY ct.id, ca.updated_at DESC
    `;
    const docsByPipeline = new Map<string, { id: string; name: string }[]>();
    const pending: { name: string; missing: string[] }[] = [];
    for (const row of signed) {
      let docs = docsByPipeline.get(row.pipeline_id);
      if (!docs) {
        docs = (
          await this.prisma.documentoBeneficio.findMany({
            where: { organizationId, pipelineId: row.pipeline_id },
            orderBy: { order: 'asc' },
            select: { id: true, name: true },
          })
        ).filter((d) => isBasicDocument(d.name));
        docsByPipeline.set(row.pipeline_id, docs);
      }
      const received = (row.metadata?.documentos ?? {}) as Record<string, unknown>;
      const missing = docs.filter((d) => !received[d.id]).map((d) => d.name);
      if (missing.length > 0) {
        pending.push({ name: row.name?.trim() || 'Sem nome', missing });
      }
    }

    // 3) Movimento do follow-up nas últimas 24h.
    const since = new Date(now - DAY_MS);
    const logs = await this.prisma.conversationAuditLog.findMany({
      where: {
        action: { in: [AUDIT_FOLLOW_UP_SENT, AUDIT_FOLLOW_UP_EXHAUSTED] },
        createdAt: { gte: since },
        conversation: {
          organizationId,
          ...(channelId ? { channelId } : {}),
        },
      },
      select: { action: true, conversationId: true, createdAt: true },
    });
    const sentLogs = logs.filter((l) => l.action === AUDIT_FOLLOW_UP_SENT);
    const exhausted = logs.filter((l) => l.action === AUDIT_FOLLOW_UP_EXHAUSTED).length;
    let replied = 0;
    for (const convId of new Set(sentLogs.map((l) => l.conversationId))) {
      const first = sentLogs
        .filter((l) => l.conversationId === convId)
        .reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
      const answer = await this.prisma.message.findFirst({
        where: {
          conversationId: convId,
          direction: 'INBOUND',
          createdAt: { gt: first.createdAt },
        },
        select: { id: true },
      });
      if (answer) replied++;
    }

    if (waiting.length === 0 && pending.length === 0 && logs.length === 0) {
      return null;
    }

    const date = new Intl.DateTimeFormat('pt-BR', {
      timeZone: org?.aiTimezone || 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
    }).format(new Date(now));
    const lines: string[] = [`📋 Resumo do atendimento, ${date}`];

    lines.push('', `⏳ Esperando resposta da equipe: ${waiting.length}`);
    for (const w of waiting.slice(0, MAX_LINES)) {
      const who = [w.name?.trim() || 'Sem nome', w.phone ? `(${w.phone})` : '']
        .filter(Boolean)
        .join(' ');
      const ago = humanizeSilence((now - new Date(w.since).getTime()) / 60_000);
      lines.push(`• ${who} · ${w.assignee ?? 'sem responsável'} · há ${ago}`);
    }
    if (waiting.length > MAX_LINES) {
      lines.push(`… e mais ${waiting.length - MAX_LINES}`);
    }

    lines.push('', `📎 Assinados com documento pendente: ${pending.length}`);
    for (const p of pending.slice(0, MAX_LINES)) {
      lines.push(`• ${p.name}: falta ${p.missing.join('; ')}`);
    }
    if (pending.length > MAX_LINES) {
      lines.push(`… e mais ${pending.length - MAX_LINES}`);
    }

    lines.push(
      '',
      `🔁 Follow-up da IA nas últimas 24h: ${sentLogs.length} enviados, ${replied} responderam, ${exhausted} sem retorno`,
    );
    return lines.join('\n');
  }
}
