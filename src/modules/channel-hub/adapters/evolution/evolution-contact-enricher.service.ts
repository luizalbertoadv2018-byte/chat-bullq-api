import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { EvolutionHttpClient } from './evolution.http-client';
import { UploadsService } from '../../../messaging/messages/uploads.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';

/**
 * Foto de perfil dos contatos e grupos de um canal Evolution. Mesmo contrato
 * do enricher do Zappfy: chamado no inbound, ao abrir o inbox e ao abrir a
 * conversa, e ele próprio decide se vale ir ao provider.
 */
@Injectable()
export class EvolutionContactEnricherService {
  private readonly logger = new Logger(EvolutionContactEnricherService.name);
  /** Depois disso a cópia local da foto é considerada velha e rebuscada. */
  private static readonly AVATAR_TTL_DAYS = 7;
  /** Quanto tempo esperar antes de perguntar de novo por um contato que não tem foto. */
  private static readonly NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: EvolutionHttpClient,
    private readonly uploads: UploadsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async enrich(
    channel: Channel,
    externalContactId: string,
    options: { force?: boolean; maxAgeDays?: number } = {},
  ): Promise<void> {
    const force = options.force ?? false;
    const maxAgeDays =
      options.maxAgeDays ?? EvolutionContactEnricherService.AVATAR_TTL_DAYS;
    try {
      const contactChannel = await this.prisma.contactChannel.findUnique({
        where: {
          uq_contact_channel_external: {
            channelId: channel.id,
            externalId: externalContactId,
          },
        },
        include: { contact: true },
      });
      if (!contactChannel) return;

      // Grupo: o webhook de mensagem não traz o nome do grupo, só o de quem
      // falou. Sem buscar aqui, todo grupo aparecia como "Desconhecido".
      const isGroup = externalContactId.endsWith('@g.us');
      if (isGroup && !contactChannel.contact.name?.trim()) {
        await this.syncGroupName(channel, externalContactId, contactChannel.contact);
      }

      // `null` cobre também a URL herdada de outro ambiente (localhost, túnel
      // antigo): o arquivo não está aqui, então rebuscamos.
      const ageDays = this.uploads.avatarAgeInDays(
        contactChannel.contact.avatarUrl,
      );
      const stale = ageDays === null || ageDays > maxAgeDays;
      if (!stale && !force) return;

      // Contato sem foto (perfil vazio ou privacidade) nunca fica "em dia":
      // sem esta trava ele seria consultado a cada mensagem, pra sempre.
      const metadata = (contactChannel.contact.metadata ?? {}) as Record<string, any>;
      const checkedAt = metadata.avatarCheckedAt
        ? new Date(metadata.avatarCheckedAt).getTime()
        : 0;
      const checkedRecently =
        Date.now() - checkedAt < EvolutionContactEnricherService.NEGATIVE_TTL_MS;
      if (checkedRecently && !force) return;

      await this.prisma.contact.update({
        where: { id: contactChannel.contactId },
        data: { metadata: { ...metadata, avatarCheckedAt: new Date().toISOString() } },
      });

      // Na revalidação periódica da foto, aproveita pra pegar um nome de
      // grupo que tenha mudado.
      if (isGroup && contactChannel.contact.name?.trim()) {
        await this.syncGroupName(channel, externalContactId, contactChannel.contact);
      }

      const avatarUrl = await this.downloadAvatar(
        channel,
        externalContactId,
        contactChannel.contactId,
      );
      if (!avatarUrl) return;

      if (avatarUrl !== contactChannel.profileAvatarUrl) {
        await this.prisma.contactChannel.update({
          where: { id: contactChannel.id },
          data: { profileAvatarUrl: avatarUrl },
        });
      }
      if (avatarUrl === contactChannel.contact.avatarUrl) return;

      await this.prisma.contact.update({
        where: { id: contactChannel.contactId },
        data: { avatarUrl },
      });

      // Avisa quem está com o inbox aberto, pra foto aparecer sem recarregar.
      this.realtime.emitToOrg(
        contactChannel.contact.organizationId,
        'contact:avatar',
        {
          contactId: contactChannel.contactId,
          avatarUrl,
          name: contactChannel.contact.name ?? null,
        },
      );

      this.logger.log(`Evolution contact enriched: ${externalContactId} + avatar`);
    } catch (err: any) {
      this.logger.warn(
        `Evolution contact enrichment failed for ${externalContactId}: ${err.message}`,
      );
    }
  }

  /** Grava o nome atual do grupo no contato e avisa o inbox aberto. */
  private async syncGroupName(
    channel: Channel,
    groupJid: string,
    contact: { id: string; organizationId: string; name: string | null; avatarUrl: string | null },
  ): Promise<void> {
    try {
      const subject = await this.httpClient.fetchGroupSubject(channel, groupJid);
      if (!subject || subject === contact.name) return;
      await this.prisma.contact.update({
        where: { id: contact.id },
        data: { name: subject },
      });
      this.realtime.emitToOrg(contact.organizationId, 'contact:avatar', {
        contactId: contact.id,
        avatarUrl: contact.avatarUrl ?? null,
        name: subject,
      });
      this.logger.log(`Evolution group named: ${groupJid} → "${subject}"`);
    } catch (err: any) {
      this.logger.debug(`Sem nome pro grupo ${groupJid}: ${err.message}`);
    }
  }

  /**
   * Busca a foto no provider e guarda no nosso storage, devolvendo a URL
   * local. Servimos do nosso domínio porque a URL do WhatsApp vence em
   * poucos dias (e aí o `<img>` do cliente tomaria 403).
   */
  private async downloadAvatar(
    channel: Channel,
    externalContactId: string,
    contactId: string,
  ): Promise<string | undefined> {
    try {
      const url = await this.httpClient.fetchProfilePictureUrl(
        channel,
        externalContactId,
      );
      if (!url) return undefined;
      const buffer = await this.httpClient.getMediaBuffer(url);
      if (!buffer?.byteLength) return undefined;
      return await this.uploads.saveAvatar({
        key: contactId,
        buffer,
        mimeType: 'image/jpeg',
      });
    } catch (err: any) {
      // Sem foto, foto restrita por privacidade ou provider fora: seguimos
      // sem avatar, a UI cai nas iniciais.
      this.logger.debug(`Sem avatar pra ${externalContactId}: ${err.message}`);
      return undefined;
    }
  }
}
