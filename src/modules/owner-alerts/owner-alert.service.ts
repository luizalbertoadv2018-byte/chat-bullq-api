import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

interface OwnerAlertsConfig {
  /** Canal (Evolution) por onde o aviso sai. */
  channelId?: string;
  /** Telefones que recebem os avisos (com DDD). */
  phones?: string[];
}

/**
 * Avisa o dono do escritório, no WhatsApp dele, quando um lead precisa de
 * gente: pediu atendimento humano, assinou a ficha etc. Sem isso o pedido
 * ficava só num cartão do painel que expira em 30 minutos.
 *
 * Configuração em `organizations.settings.ownerAlerts` = { channelId, phones }.
 * Sem configuração, não faz nada. Nunca lança: aviso é acessório e não pode
 * derrubar o fluxo que o chamou.
 */
@Injectable()
export class OwnerAlertService {
  private readonly logger = new Logger(OwnerAlertService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** DDD + 8 últimos dígitos: tolera 55 na frente e o nono dígito. */
  private key(phone: string | null | undefined): string {
    let n = (phone ?? '').replace(/[^0-9]/g, '');
    if (n.length > 11 && n.startsWith('55')) n = n.slice(2);
    if (n.length < 10) return '';
    return n.slice(0, 2) + n.slice(-8);
  }

  private async config(
    organizationId: string,
  ): Promise<OwnerAlertsConfig | null> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const cfg = ((org?.settings ?? {}) as Record<string, any>).ownerAlerts as
      | OwnerAlertsConfig
      | undefined;
    if (
      !cfg?.channelId ||
      !Array.isArray(cfg.phones) ||
      cfg.phones.length === 0
    ) {
      return null;
    }
    return cfg;
  }

  /**
   * O número de quem recebe os avisos não é lead: se ele responder no chat
   * do aviso, o agente de IA não deve atendê-lo.
   */
  async isAlertPhone(
    organizationId: string,
    phone: string | null | undefined,
  ): Promise<boolean> {
    try {
      const k = this.key(phone);
      if (!k) return false;
      const cfg = await this.config(organizationId);
      return !!cfg?.phones?.some((p) => this.key(p) === k);
    } catch {
      return false;
    }
  }

  /** Aviso sobre uma conversa: monta "Nome (telefone)" e envia. */
  async notifyAboutConversation(
    conversationId: string,
    title: string,
    detail?: string,
  ): Promise<void> {
    try {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: {
          organizationId: true,
          contact: { select: { name: true, phone: true } },
        },
      });
      if (!conversation) return;
      await this.notifyAboutContact(
        conversation.organizationId,
        conversation.contact,
        title,
        detail,
      );
    } catch (err: any) {
      this.logger.warn(
        `aviso não enviado (conv ${conversationId}): ${err?.message ?? err}`,
      );
    }
  }

  async notifyAboutContact(
    organizationId: string,
    contact: { name?: string | null; phone?: string | null } | null,
    title: string,
    detail?: string,
  ): Promise<void> {
    const who = [
      contact?.name?.trim(),
      contact?.phone ? `(${contact.phone})` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const lines = [title, who ? `Lead: ${who}` : '', detail?.trim() ?? ''].filter(
      Boolean,
    );
    await this.notify(organizationId, lines.join('\n'));
  }

  async notify(organizationId: string, text: string): Promise<void> {
    try {
      const cfg = await this.config(organizationId);
      if (!cfg) return;

      const channel = await this.prisma.channel.findFirst({
        where: { id: cfg.channelId, organizationId, deletedAt: null },
      });
      if (!channel || channel.type !== ChannelType.WHATSAPP_EVOLUTION) {
        this.logger.warn(
          'ownerAlerts.channelId não aponta para um canal Evolution ativo',
        );
        return;
      }
      const c = (channel.config ?? {}) as Record<string, any>;
      const baseUrl = String(c.baseUrl ?? '')
        .trim()
        .replace(/[/]$/, '');
      const apiKey = String(c.apiKey ?? c.apikey ?? '').trim();
      const instance = String(c.instance ?? c.instanceName ?? '').trim();
      if (!baseUrl || !apiKey || !instance) return;

      for (const phone of cfg.phones ?? []) {
        let number = String(phone).replace(/[^0-9]/g, '');
        if (number.length <= 11) number = `55${number}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const res = await fetch(
            `${baseUrl}/message/sendText/${encodeURIComponent(instance)}`,
            {
              method: 'POST',
              headers: { apikey: apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ number, text }),
              signal: controller.signal,
            },
          );
          if (!res.ok) {
            this.logger.warn(`aviso p/ ${number} falhou: HTTP ${res.status}`);
          } else {
            this.logger.log(
              `aviso enviado p/ ${number}: ${text.split('\n')[0]}`,
            );
          }
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err: any) {
      this.logger.warn(`aviso não enviado: ${err?.message ?? err}`);
    }
  }
}
