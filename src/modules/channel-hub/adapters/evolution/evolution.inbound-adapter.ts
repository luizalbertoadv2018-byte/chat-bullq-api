import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import * as crypto from 'crypto';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult, VerificationResponse } from '../../ports/types';
import { EvolutionMessageMapper } from './evolution.message-mapper';

@Injectable()
export class EvolutionInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_EVOLUTION;
  private readonly logger = new Logger(EvolutionInboundAdapter.name);

  constructor(private readonly mapper: EvolutionMessageMapper) {}

  extractLocators(
    payload: unknown,
    headers: Record<string, string>,
  ): ChannelLocator[] {
    const event = (payload ?? {}) as Record<string, any>;
    const instanceId = event.instance || event.instanceName || undefined;
    const token = event.apikey || headers['apikey'] || undefined;
    const locator: ChannelLocator = {};
    if (instanceId) locator.instanceId = String(instanceId);
    if (token) locator.token = String(token);
    return [locator];
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const config = (channel.config ?? {}) as Record<string, any>;
    // Match forte por nome da instância.
    if (locator.instanceId && config.instance) {
      return String(config.instance) === locator.instanceId;
    }
    // Match por apikey da instância.
    if (locator.token && config.apiKey) {
      return this.timingSafeEqualStr(String(config.apiKey), String(locator.token));
    }
    return false;
  }

  validateWebhook(
    headers: Record<string, string>,
    _rawBody: Buffer,
    webhookSecret?: string,
    channel?: Channel,
  ): boolean {
    // O match por instância/apikey já foi feito em matchesChannel. Se o
    // operador definiu um webhookSecret, exige-o como defesa extra.
    if (!webhookSecret) return true;
    const candidate = headers['apikey'] || headers['x-webhook-token'];
    if (!candidate) return false;
    if (this.timingSafeEqualStr(webhookSecret, candidate)) return true;
    const configKey = (channel?.config as any)?.apiKey;
    return !!configKey && this.timingSafeEqualStr(String(configKey), candidate);
  }

  parseWebhook(payload: unknown, _channel?: Channel): WebhookParseResult {
    const result: WebhookParseResult = { messages: [], statuses: [], errors: [] };
    try {
      const event = payload as any;
      // Evolution manda o evento como 'messages.upsert' OU 'MESSAGES_UPSERT'.
      const ev = String(event?.event || '').toLowerCase().replace(/_/g, '.');
      const data = event?.data;

      if (ev === 'messages.upsert' || ev === 'send.message') {
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const normalized = this.mapper.normalizeInbound(item);
          if (normalized) result.messages.push(normalized);
        }
      } else if (ev === 'messages.update') {
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const status = this.mapper.normalizeStatus(item);
          if (status) result.statuses.push(status);
        }
      }
    } catch (error: any) {
      this.logger.error(`Falha ao parsear webhook Evolution: ${error.message}`);
      result.errors.push({
        code: 'PARSE_ERROR',
        message: error.message,
        rawData: payload,
      });
    }
    return result;
  }

  handleVerification(): VerificationResponse {
    return { statusCode: 200, body: 'OK' };
  }

  private timingSafeEqualStr(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    try {
      return crypto.timingSafeEqual(ba, bb);
    } catch {
      return false;
    }
  }
}
