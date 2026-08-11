import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

interface WaOfficialConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  apiVersion?: string;
}

/**
 * Campos de webhook que o app precisa assinar (objeto
 * `whatsapp_business_account`) para o modo COEXISTÊNCIA funcionar:
 *  - messages: inbound do cliente (padrão Cloud API)
 *  - message_echoes / smb_message_echoes: ecos do que o dono envia PELO CELULAR
 *  - history: sincronização das conversas antigas ao conectar (~6 meses)
 *  - smb_app_state_sync: contatos do app sincronizados
 *  - message_template_status_update: aprovação/reprovação de templates HSM
 */
const COEXISTENCE_WEBHOOK_FIELDS = [
  'messages',
  'smb_message_echoes',
  'message_echoes',
  'history',
  'smb_app_state_sync',
  'message_template_status_update',
];

@Injectable()
export class WhatsAppOfficialHttpClient {
  private readonly logger = new Logger(WhatsAppOfficialHttpClient.name);

  /** Config do App Meta (compartilhada entre canais criados via Embedded Signup). */
  private getAppConfig() {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const apiVersion = process.env.META_GRAPH_VERSION || 'v21.0';
    if (!appId || !appSecret) {
      throw new Error(
        'META_APP_ID / META_APP_SECRET não configurados — Embedded Signup indisponível.',
      );
    }
    return { appId, appSecret, apiVersion };
  }

  private getConfig(channel: Channel): WaOfficialConfig {
    const config = channel.config as Record<string, any>;
    return {
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
      businessAccountId: config.businessAccountId,
      apiVersion: config.apiVersion || 'v21.0',
    };
  }

  private createClient(channel: Channel): AxiosInstance {
    const cfg = this.getConfig(channel);
    return axios.create({
      baseURL: `https://graph.facebook.com/${cfg.apiVersion}`,
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      timeout: 30000,
    });
  }

  async sendMessage(
    channel: Channel,
    payload: Record<string, any>,
  ): Promise<any> {
    const cfg = this.getConfig(channel);
    const client = this.createClient(channel);
    try {
      const { data } = await client.post(
        `/${cfg.phoneNumberId}/messages`,
        payload,
      );
      return data;
    } catch (error: any) {
      this.logger.error(
        `WA Official API error: ${error.response?.data?.error?.message || error.message}`,
      );
      throw error;
    }
  }

  async getMediaUrl(channel: Channel, mediaId: string): Promise<string> {
    const client = this.createClient(channel);
    const { data } = await client.get(`/${mediaId}`);
    return data.url;
  }

  async downloadMedia(channel: Channel, url: string): Promise<Buffer> {
    const cfg = this.getConfig(channel);
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }

  async verifyPhoneNumber(channel: Channel): Promise<any> {
    const cfg = this.getConfig(channel);
    const client = this.createClient(channel);
    try {
      const { data } = await client.get(`/${cfg.phoneNumberId}`);
      return data;
    } catch (error: any) {
      this.logger.error(`WA Official verify failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Subscribes our app to receive webhooks for this WABA. Idempotent on
   * Meta's side — re-calling is safe. Requires `whatsapp_business_management`
   * scope on the access token.
   */
  async subscribeApp(channel: Channel): Promise<any> {
    const cfg = this.getConfig(channel);
    if (!cfg.businessAccountId) {
      throw new Error('businessAccountId required to subscribe app');
    }
    const client = this.createClient(channel);
    const { data } = await client.post(`/${cfg.businessAccountId}/subscribed_apps`);
    return data;
  }

  /**
   * Templates HSM aprovados da WABA — obrigatórios pra iniciar conversa fora
   * da janela de 24h (cold start). Só retorna os com `status: APPROVED`;
   * templates pendentes/rejeitados pela Meta não são utilizáveis.
   */
  async listTemplates(channel: Channel): Promise<
    Array<{
      name: string;
      language: string;
      components: Array<Record<string, any>>;
    }>
  > {
    const cfg = this.getConfig(channel);
    if (!cfg.businessAccountId) {
      throw new Error('businessAccountId required to list templates');
    }
    const client = this.createClient(channel);
    const { data } = await client.get(
      `/${cfg.businessAccountId}/message_templates`,
      { params: { fields: 'name,status,language,components', limit: 100 } },
    );
    return (data?.data ?? [])
      .filter((t: any) => t.status === 'APPROVED')
      .map((t: any) => ({
        name: t.name,
        language: t.language,
        components: t.components ?? [],
      }));
  }

  // ─────────────────────────── Embedded Signup ───────────────────────────

  /**
   * Troca o `code` devolvido pelo popup de Embedded Signup por um access
   * token de negócio (System User). O token é vinculado ao App e à WABA que
   * o cliente selecionou/conectou no fluxo.
   */
  async exchangeCodeForToken(code: string): Promise<string> {
    const { appId, appSecret, apiVersion } = this.getAppConfig();
    try {
      const { data } = await axios.get(
        `https://graph.facebook.com/${apiVersion}/oauth/access_token`,
        {
          params: {
            client_id: appId,
            client_secret: appSecret,
            code,
          },
          timeout: 30000,
        },
      );
      if (!data?.access_token) {
        throw new Error('Meta não retornou access_token na troca do code.');
      }
      return data.access_token as string;
    } catch (error: any) {
      const msg =
        error.response?.data?.error?.message || error.message || 'erro desconhecido';
      this.logger.error(`Embedded Signup token exchange falhou: ${msg}`);
      throw new Error(`Falha ao trocar o code por token: ${msg}`);
    }
  }

  /** Lê nome/telefone verificados a partir de um token + phoneNumberId cru. */
  async getPhoneNumberInfoWithToken(
    accessToken: string,
    phoneNumberId: string,
  ): Promise<{ displayPhoneNumber?: string; verifiedName?: string }> {
    const { apiVersion } = this.getAppConfig();
    const { data } = await axios.get(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`,
      {
        params: { fields: 'display_phone_number,verified_name' },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
      },
    );
    return {
      displayPhoneNumber: data?.display_phone_number,
      verifiedName: data?.verified_name,
    };
  }

  /** Assina o app na WABA usando um token cru (fluxo de onboarding). */
  async subscribeAppWithToken(
    accessToken: string,
    wabaId: string,
  ): Promise<void> {
    const { apiVersion } = this.getAppConfig();
    await axios.post(
      `https://graph.facebook.com/${apiVersion}/${wabaId}/subscribed_apps`,
      {},
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
      },
    );
  }

  /**
   * Garante que o App esteja inscrito nos campos de webhook de coexistência
   * (objeto whatsapp_business_account), apontando pra nossa callback_url.
   * Usa o app access token (`{appId}|{appSecret}`). Idempotente na Meta.
   * Fire-and-forget no chamador — se falhar, o dono pode configurar os campos
   * manualmente no painel do App.
   */
  async ensureAppWebhookFields(callbackUrl: string, verifyToken: string): Promise<void> {
    const { appId, appSecret, apiVersion } = this.getAppConfig();
    try {
      await axios.post(
        `https://graph.facebook.com/${apiVersion}/${appId}/subscriptions`,
        null,
        {
          params: {
            object: 'whatsapp_business_account',
            callback_url: callbackUrl,
            verify_token: verifyToken,
            fields: COEXISTENCE_WEBHOOK_FIELDS.join(','),
            access_token: `${appId}|${appSecret}`,
          },
          timeout: 30000,
        },
      );
      this.logger.log(
        `App ${appId} inscrito nos campos de webhook de coexistência (${callbackUrl})`,
      );
    } catch (error: any) {
      const msg =
        error.response?.data?.error?.message || error.message || 'erro desconhecido';
      this.logger.warn(`ensureAppWebhookFields falhou: ${msg}`);
    }
  }
}
