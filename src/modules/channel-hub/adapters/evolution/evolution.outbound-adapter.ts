import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { EvolutionMessageMapper } from './evolution.message-mapper';
import { EvolutionHttpClient } from './evolution.http-client';

@Injectable()
export class EvolutionOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_EVOLUTION;
  private readonly logger = new Logger(EvolutionOutboundAdapter.name);

  constructor(
    private readonly mapper: EvolutionMessageMapper,
    private readonly httpClient: EvolutionHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const { endpoint, payload } = this.mapper.denormalize(
      message,
      contactExternalId,
    );
    const response = await this.httpClient.sendRequest(channel, endpoint, payload);
    return {
      externalId: response?.key?.id || response?.messageId || response?.id || '',
      providerResponse: response,
    };
  }

  async sendTypingIndicator(
    channel: Channel,
    contactExternalId: string,
  ): Promise<void> {
    const number = contactExternalId.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    try {
      await this.httpClient.sendRequest(channel, '/chat/sendPresence', {
        number,
        presence: 'composing',
        delay: 1200,
      });
    } catch (error: any) {
      this.logger.warn(`Typing indicator (Evolution) falhou: ${error.message}`);
    }
  }

  async getMediaUrl(_channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(_channel: Channel, _mediaId: string): Promise<Buffer> {
    // Evolution entrega mídia via getBase64FromMediaMessage (data URI);
    // o download binário direto não é usado no pipeline atual.
    throw new Error('downloadMedia não suportado no Evolution (use resolveInboundMediaUrl).');
  }

  async resolveInboundMediaUrl(
    channel: Channel,
    hint: { externalMessageId: string; mimeType?: string },
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    // Reconstrói a key mínima que o Evolution precisa pra devolver o base64.
    return this.httpClient.getBase64Media(channel, {
      id: hint.externalMessageId,
    });
  }

  getRateLimits(): RateLimitConfig {
    return { maxPerSecond: 1, maxPerMinute: 30, windowMs: 60000 };
  }
}
