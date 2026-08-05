import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

interface EvolutionConfig {
  /** URL base da instância Evolution (ex.: https://evo.meuservidor.com). */
  baseUrl: string;
  /** API key (global ou da instância) — vai no header `apikey`. */
  apiKey: string;
  /** Nome da instância no Evolution (entra no path dos endpoints v2). */
  instance: string;
}

/**
 * Cliente HTTP da Evolution API v2 (WhatsApp não oficial, baileys). Cada canal
 * guarda sua própria `baseUrl` + `apiKey` + `instance` em `channel.config`.
 * Endpoints v2 levam o nome da instância no path (ex.: /message/sendText/{inst}).
 *
 * Docs: https://github.com/evolution-foundation/evolution-api
 */
@Injectable()
export class EvolutionHttpClient {
  private readonly logger = new Logger(EvolutionHttpClient.name);

  private cfg(channel: Channel): EvolutionConfig {
    const c = (channel.config ?? {}) as Record<string, any>;
    const baseUrl = String(c.baseUrl ?? '').trim().replace(/\/$/, '');
    const apiKey = String(c.apiKey ?? c.apikey ?? '').trim();
    const instance = String(c.instance ?? c.instanceName ?? '').trim();
    if (!baseUrl || !apiKey || !instance) {
      throw new BadRequestException(
        'Canal Evolution mal configurado (faltam baseUrl, apiKey ou instance).',
      );
    }
    return { baseUrl, apiKey, instance };
  }

  private client(cfg: EvolutionConfig): AxiosInstance {
    return axios.create({
      baseURL: cfg.baseUrl,
      headers: { apikey: cfg.apiKey, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
  }

  /** POST em `{endpoint}/{instance}` — usado pelos /message/send*. */
  async sendRequest(
    channel: Channel,
    endpoint: string,
    payload: Record<string, any>,
  ): Promise<any> {
    const cfg = this.cfg(channel);
    try {
      const res = await this.client(cfg).post(
        `${endpoint}/${encodeURIComponent(cfg.instance)}`,
        payload,
      );
      return res.data;
    } catch (error: any) {
      this.logger.error(
        `Evolution ${endpoint} falhou: ${error.response?.data?.message || error.message}`,
      );
      throw error;
    }
  }

  /** Estado da conexão da instância: open | connecting | close. */
  async getConnectionState(channel: Channel): Promise<string> {
    const cfg = this.cfg(channel);
    try {
      const res = await this.client(cfg).get(
        `/instance/connectionState/${encodeURIComponent(cfg.instance)}`,
      );
      return res.data?.instance?.state ?? res.data?.state ?? 'unknown';
    } catch (error: any) {
      this.logger.warn(`Evolution connectionState falhou: ${error.message}`);
      return 'unknown';
    }
  }

  /**
   * Inicia/obtém o pareamento por QR Code da instância. Retorna o base64 da
   * imagem do QR (data URI) e/ou o código de pareamento numérico.
   */
  async connect(channel: Channel): Promise<{
    qrBase64: string | null;
    pairingCode: string | null;
    state: string;
  }> {
    const cfg = this.cfg(channel);
    try {
      const res = await this.client(cfg).get(
        `/instance/connect/${encodeURIComponent(cfg.instance)}`,
      );
      const d = res.data ?? {};
      const raw: string | undefined = d.base64 || d.qrcode?.base64 || d.qrcode;
      const qrBase64 = raw
        ? raw.startsWith('data:')
          ? raw
          : `data:image/png;base64,${raw}`
        : null;
      return {
        qrBase64,
        pairingCode: d.pairingCode || d.code || d.qrcode?.pairingCode || null,
        state: d.instance?.state || 'connecting',
      };
    } catch (error: any) {
      this.logger.error(`Evolution connect falhou: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cria a instância no Evolution já apontando o webhook pro Chat BullQ.
   * `webhookUrl` = a URL pública do nosso gateway de webhook.
   */
  async createInstance(
    cfg: EvolutionConfig,
    webhookUrl: string,
  ): Promise<any> {
    const client = axios.create({
      baseURL: cfg.baseUrl,
      headers: { apikey: cfg.apiKey, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    const body = {
      instanceName: cfg.instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      webhook: {
        url: webhookUrl,
        byEvents: false,
        base64: true,
        events: [
          'MESSAGES_UPSERT',
          'MESSAGES_UPDATE',
          'SEND_MESSAGE',
          'CONNECTION_UPDATE',
        ],
      },
    };
    const res = await client.post('/instance/create', body);
    return res.data;
  }

  /** Cria a instância a partir de um Channel já persistido. */
  async createInstanceForChannel(
    channel: Channel,
    webhookUrl: string,
  ): Promise<any> {
    return this.createInstance(this.cfg(channel), webhookUrl);
  }

  /**
   * Baixa a mídia de uma mensagem inbound como base64 (o WhatsApp entrega a
   * URL criptografada .enc que o browser não abre). Retorna um data URI
   * "playável" que a nossa camada de mídia re-hospeda.
   */
  async getBase64Media(
    channel: Channel,
    messageKey: Record<string, any>,
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    const cfg = this.cfg(channel);
    const res = await this.client(cfg).post(
      `/chat/getBase64FromMediaMessage/${encodeURIComponent(cfg.instance)}`,
      { message: { key: messageKey }, convertToMp4: false },
    );
    const d = res.data ?? {};
    const b64: string = d.base64 || '';
    const mimeType: string | undefined = d.mimetype || d.mimeType;
    if (!b64) throw new BadRequestException('Evolution não retornou a mídia.');
    return {
      fileUrl: b64.startsWith('data:')
        ? b64
        : `data:${mimeType || 'application/octet-stream'};base64,${b64}`,
      mimeType,
    };
  }
}
