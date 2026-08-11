import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import * as crypto from 'crypto';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult, VerificationResponse } from '../../ports/types';
import { WhatsAppOfficialMessageMapper } from './whatsapp-official.message-mapper';

@Injectable()
export class WhatsAppOfficialInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_OFFICIAL;
  private readonly logger = new Logger(WhatsAppOfficialInboundAdapter.name);

  constructor(private readonly mapper: WhatsAppOfficialMessageMapper) {}

  extractLocators(payload: unknown): ChannelLocator[] {
    const body = (payload ?? {}) as Record<string, any>;
    const entries: any[] = body?.entry || [];
    const seen = new Set<string>();
    const locators: ChannelLocator[] = [];

    for (const entry of entries) {
      const businessAccountId: string | undefined = entry?.id
        ? String(entry.id)
        : undefined;
      const changes = entry?.changes || [];
      for (const change of changes) {
        const metadata = change?.value?.metadata || {};
        const phoneNumberId: string | undefined = metadata.phone_number_id
          ? String(metadata.phone_number_id)
          : undefined;
        const key = `${businessAccountId ?? '-'}:${phoneNumberId ?? '-'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const locator: ChannelLocator = {};
        if (phoneNumberId) locator.phoneNumberId = phoneNumberId;
        if (businessAccountId) locator.businessAccountId = businessAccountId;
        if (phoneNumberId || businessAccountId) locators.push(locator);
      }
    }

    return locators;
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const config = (channel.config ?? {}) as Record<string, any>;
    if (locator.phoneNumberId && config.phoneNumberId) {
      return String(config.phoneNumberId) === locator.phoneNumberId;
    }
    if (locator.businessAccountId && config.businessAccountId) {
      return String(config.businessAccountId) === locator.businessAccountId;
    }
    return false;
  }

  validateWebhook(
    headers: Record<string, string>,
    rawBody: Buffer,
    _webhookSecret?: string,
    channel?: Channel,
  ): boolean {
    const appSecret = (channel?.config as Record<string, any> | undefined)
      ?.appSecret;
    if (!appSecret) {
      this.logger.warn(
        `WA Official channel ${channel?.id} missing config.appSecret — rejecting webhook`,
      );
      return false;
    }

    const signature = headers['x-hub-signature-256'];
    if (!signature) return false;

    const expected =
      'sha256=' +
      crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
      );
    } catch {
      return false;
    }
  }

  parseWebhook(payload: unknown, channel?: Channel): WebhookParseResult {
    const result: WebhookParseResult = {
      messages: [],
      statuses: [],
      errors: [],
    };

    try {
      const body = payload as Record<string, any>;
      const entries = body?.entry || [];
      const rawExpected = (channel?.config as any)?.phoneNumberId;
      const expectedPhoneNumberId = rawExpected ? String(rawExpected) : undefined;

      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const value = change?.value;
          if (!value) continue;

          const metadataPhoneId = value.metadata?.phone_number_id
            ? String(value.metadata.phone_number_id)
            : undefined;
          // Strict scoping: drop events for a different phone_number_id
          if (
            expectedPhoneNumberId &&
            metadataPhoneId &&
            metadataPhoneId !== expectedPhoneNumberId
          ) {
            continue;
          }

          const field = change?.field;

          // Coexistência — ecos de mensagens enviadas PELO CELULAR (app
          // WhatsApp Business). Sem isso, tudo que o dono responde direto no
          // celular somia do inbox. Viram mensagens de SAÍDA (isEcho).
          if (field === 'smb_message_echoes') {
            const echoes = value.message_echoes || [];
            for (const echo of echoes) {
              const normalized = this.mapper.normalizeEcho(echo);
              if (normalized) result.messages.push(normalized);
            }
            continue;
          }

          // Coexistência — sincronização de histórico (até ~6 meses) disparada
          // quando o número é conectado. Faz o backfill das conversas antigas.
          if (field === 'history') {
            const businessDigits = String(
              value.metadata?.display_phone_number || '',
            ).replace(/\D/g, '');
            const historyChunks = value.history || [];
            for (const chunk of historyChunks) {
              for (const thread of chunk?.threads || []) {
                for (const msg of thread?.messages || []) {
                  const normalized = this.mapper.normalizeHistoryMessage(
                    msg,
                    businessDigits,
                  );
                  if (normalized) result.messages.push(normalized);
                }
              }
            }
            continue;
          }

          const contacts = value.contacts || [];
          const messages = value.messages || [];
          const statuses = value.statuses || [];

          for (const msg of messages) {
            const contact =
              contacts.find((c: any) => c.wa_id === msg.from) || {};
            const normalized = this.mapper.normalizeInbound(msg, contact);
            if (normalized) {
              result.messages.push(normalized);
            }
          }

          for (const status of statuses) {
            const normalized = this.mapper.normalizeStatus(status);
            if (normalized) {
              result.statuses.push(normalized);
            }
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to parse WA Official webhook: ${error.message}`);
      result.errors.push({
        code: 'PARSE_ERROR',
        message: error.message,
        rawData: payload,
      });
    }

    return result;
  }

  handleVerification(
    query: Record<string, string>,
    webhookSecret?: string,
    channel?: Channel,
  ): VerificationResponse {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const verifyToken =
      (channel?.config as Record<string, any> | undefined)?.verifyToken ||
      webhookSecret;

    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      this.logger.log('Meta webhook verification successful');
      return { statusCode: 200, body: challenge };
    }

    this.logger.warn('Meta webhook verification failed');
    return { statusCode: 403, body: { error: 'Verification failed' } };
  }
}
