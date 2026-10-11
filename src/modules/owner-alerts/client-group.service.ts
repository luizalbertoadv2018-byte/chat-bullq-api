import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OwnerAlertService } from './owner-alert.service';

interface ClientGroupsConfig {
  enabled?: boolean;
  /** Números do escritório que entram em todo grupo, como administradores. */
  adminPhones?: string[];
  /** Complemento do nome do grupo: "<cliente> | <nameSuffix>". */
  nameSuffix?: string;
}

interface EvolutionCfg {
  baseUrl: string;
  apiKey: string;
  instance: string;
}

/**
 * Grupo de WhatsApp por cliente, criado quando a ficha é assinada: cliente +
 * números do escritório como administradores. É o canal de contingência — se
 * o número de atendimento for banido, o contato com o cliente continua pelo
 * grupo, que segue de pé enquanto houver outro administrador.
 *
 * Configuração em `organizations.settings.clientGroups` =
 * { enabled, adminPhones, nameSuffix }. Idempotente por contato
 * (`contact.metadata.clientGroupJid`). Nunca lança.
 */
@Injectable()
export class ClientGroupService {
  private readonly logger = new Logger(ClientGroupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerAlerts: OwnerAlertService,
  ) {}

  private digits(v: string | null | undefined): string {
    return (v ?? '').replace(/[^0-9]/g, '');
  }

  /** Número no formato que o provider espera (com DDI 55). */
  private toNumber(phone: string): string {
    const n = this.digits(phone);
    return n.length <= 11 ? `55${n}` : n;
  }

  /** DDD + 8 últimos dígitos: compara ignorando DDI e nono dígito. */
  private key(phone: string | null | undefined): string {
    let n = this.digits(phone);
    if (n.length > 11 && n.startsWith('55')) n = n.slice(2);
    if (n.length < 10) return '';
    return n.slice(0, 2) + n.slice(-8);
  }

  private async call(
    cfg: EvolutionCfg,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: any }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: { apikey: cfg.apiKey, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param signedName nome completo da ficha assinada; o nome do contato no
   *   WhatsApp costuma ser apelido ou emoji e não serve pra nomear o grupo.
   */
  async ensureForContact(
    contactId: string,
    signedName?: string | null,
  ): Promise<void> {
    try {
      const contact = await this.prisma.contact.findUnique({
        where: { id: contactId },
        include: {
          organization: { select: { settings: true } },
          channels: {
            include: { channel: true },
            orderBy: { createdAt: 'desc' },
          },
        },
      });
      if (!contact) return;

      const meta = (contact.metadata ?? {}) as Record<string, any>;
      if (meta.clientGroupJid) return; // já tem grupo

      const cfg = ((contact.organization.settings ?? {}) as Record<string, any>)
        .clientGroups as ClientGroupsConfig | undefined;
      const adminPhones = (cfg?.adminPhones ?? []).filter(
        (p) => this.digits(p).length >= 10,
      );
      if (!cfg?.enabled || adminPhones.length === 0) return;

      // Canal Evolution por onde o cliente fala com o escritório.
      const link = contact.channels.find(
        (cc) =>
          cc.channel.type === ChannelType.WHATSAPP_EVOLUTION &&
          !cc.channel.deletedAt &&
          cc.externalId.endsWith('@s.whatsapp.net'),
      );
      if (!link) return;
      const c = (link.channel.config ?? {}) as Record<string, any>;
      const evo: EvolutionCfg = {
        baseUrl: String(c.baseUrl ?? '')
          .trim()
          .replace(/[/]$/, ''),
        apiKey: String(c.apiKey ?? c.apikey ?? '').trim(),
        instance: encodeURIComponent(
          String(c.instance ?? c.instanceName ?? '').trim(),
        ),
      };
      if (!evo.baseUrl || !evo.apiKey || !evo.instance) return;

      const clientNumber = this.digits(link.externalId.split('@')[0]);
      const admins = adminPhones
        .map((p) => this.toNumber(p))
        // o cliente não pode ser também "administrador do escritório"
        .filter((n) => this.key(n) !== this.key(clientNumber));
      if (admins.length === 0) return;

      const fullName =
        String(signedName ?? '').trim() ||
        String(contact.name ?? '').trim() ||
        clientNumber;
      const shortName = fullName.split(/\s+/).slice(0, 3).join(' ');
      const firstName = fullName.split(/\s+/)[0];
      const suffix = (cfg.nameSuffix ?? '').trim();
      // O WhatsApp limita o nome do grupo a 100 caracteres.
      const subject = (suffix ? `${shortName} | ${suffix}` : shortName).slice(0, 100);

      const created = await this.call(evo, 'POST', `/group/create/${evo.instance}`, {
        subject,
        description:
          'Canal oficial do seu caso com a equipe do escritório. Guarde este grupo.',
        participants: [clientNumber, ...admins],
      });
      const groupJid: string | undefined = created.data?.id;
      if (!created.ok || !groupJid) {
        this.logger.warn(
          `grupo do cliente não criado (contato ${contactId}): HTTP ${created.status} ${JSON.stringify(created.data ?? '').slice(0, 200)}`,
        );
        return;
      }

      // Grava já: se algo abaixo falhar, não criamos um segundo grupo depois.
      const fresh = await this.prisma.contact.findUnique({
        where: { id: contactId },
        select: { metadata: true },
      });
      await this.prisma.contact.update({
        where: { id: contactId },
        data: {
          metadata: {
            ...((fresh?.metadata ?? {}) as Record<string, any>),
            clientGroupJid: groupJid,
            clientGroupCreatedAt: new Date().toISOString(),
          } as any,
        },
      });

      // Sem outros administradores o grupo morreria junto com o nosso número.
      const promoted = await this.call(
        evo,
        'POST',
        `/group/updateParticipant/${evo.instance}?groupJid=${encodeURIComponent(groupJid)}`,
        { action: 'promote', participants: admins },
      );
      if (!promoted.ok) {
        this.logger.warn(
          `grupo ${groupJid}: não promoveu administradores (HTTP ${promoted.status})`,
        );
      }

      await this.call(evo, 'POST', `/message/sendText/${evo.instance}`, {
        number: groupJid,
        text:
          `Olá${firstName ? `, ${firstName}` : ''}! Este é o grupo oficial do seu caso com a equipe do escritório Alberto Martins Advocacia. ` +
          'Por aqui vamos te atualizar sobre o andamento e você pode falar direto com a gente.\n\n' +
          'Guarde este grupo: se algum dos nossos números mudar, o nosso contato continua por aqui.',
      });

      // Privacidade do cliente pode impedir a inclusão direta: nesse caso
      // ele recebe o convite na conversa individual.
      const members: any[] = Array.isArray(created.data?.participants)
        ? created.data.participants
        : [];
      const clientIsIn = members.some(
        (m) =>
          this.key(m?.phoneNumber ?? m?.id) === this.key(clientNumber),
      );
      let invited = false;
      if (!clientIsIn) {
        const invite = await this.call(
          evo,
          'GET',
          `/group/inviteCode/${evo.instance}?groupJid=${encodeURIComponent(groupJid)}`,
        );
        const url: string | undefined = invite.data?.inviteUrl;
        if (url) {
          await this.call(evo, 'POST', `/message/sendText/${evo.instance}`, {
            number: clientNumber,
            text: `${firstName ? `${firstName}, c` : 'C'}riamos um grupo do seu caso com a nossa equipe. Entra por este link, por favor: ${url}`,
          });
          invited = true;
        }
      }

      this.logger.log(
        `grupo do cliente criado: "${subject}" ${groupJid} (contato ${contactId}; cliente ${clientIsIn ? 'dentro' : invited ? 'convidado por link' : 'NÃO incluído'})`,
      );
      await this.ownerAlerts.notify(
        contact.organizationId,
        `👥 Grupo criado: ${subject}` +
          (clientIsIn
            ? ''
            : invited
              ? '\nO cliente não pôde ser adicionado direto; mandei o link de convite para ele.'
              : '\nAtenção: o cliente NÃO foi incluído e o convite não saiu.'),
      );
    } catch (err: any) {
      this.logger.warn(
        `grupo do cliente falhou (contato ${contactId}): ${err?.message ?? err}`,
      );
    }
  }
}
