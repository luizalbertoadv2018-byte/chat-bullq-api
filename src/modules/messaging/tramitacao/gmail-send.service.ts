import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Envia e-mails com anexo via Gmail API (OAuth do Gmail do escritório).
 * Usado para mandar arquivos ao e-mail exclusivo de cada cliente no
 * Tramitação Inteligente (que arquiva o anexo no cadastro do cliente).
 *
 * DESLIGADO até setar GMAIL_SEND_CLIENT_ID / GMAIL_SEND_CLIENT_SECRET /
 * GMAIL_SEND_REFRESH_TOKEN / GMAIL_SEND_FROM.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

@Injectable()
export class GmailSendService {
  private readonly logger = new Logger(GmailSendService.name);
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly config: ConfigService) {}

  private get clientId() {
    return this.config.get<string>('GMAIL_SEND_CLIENT_ID');
  }
  private get clientSecret() {
    return this.config.get<string>('GMAIL_SEND_CLIENT_SECRET');
  }
  private get refreshToken() {
    return this.config.get<string>('GMAIL_SEND_REFRESH_TOKEN');
  }
  get from() {
    return this.config.get<string>('GMAIL_SEND_FROM') ?? '';
  }

  isEnabled(): boolean {
    return !!(this.clientId && this.clientSecret && this.refreshToken && this.from);
  }

  private async token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.token;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId ?? '',
        client_secret: this.clientSecret ?? '',
        refresh_token: this.refreshToken ?? '',
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) throw new Error(`gmail token ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.cached = {
      token: json.access_token,
      expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
    };
    return json.access_token;
  }

  private buildRaw(input: {
    to: string;
    subject: string;
    text: string;
    filename: string;
    mimeType: string;
    bytes: Buffer;
  }): string {
    const b = 'bnd_' + Date.now() + '_' + Math.round(Math.random() * 1e9);
    const b64 = input.bytes.toString('base64').replace(/(.{76})/g, '$1\r\n');
    const subj = `=?UTF-8?B?${Buffer.from(input.subject, 'utf8').toString('base64')}?=`;
    const mime = [
      `From: ${this.from}`,
      `To: ${input.to}`,
      `Subject: ${subj}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${b}"`,
      '',
      `--${b}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      input.text,
      '',
      `--${b}`,
      `Content-Type: ${input.mimeType || 'application/octet-stream'}; name="${input.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${input.filename}"`,
      '',
      b64,
      '',
      `--${b}--`,
      '',
    ].join('\r\n');
    return Buffer.from(mime, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /** Envia o arquivo como anexo. Lança em erro (o processador trata retry). */
  async sendWithAttachment(input: {
    to: string;
    subject: string;
    text: string;
    filename: string;
    mimeType: string;
    bytes: Buffer;
  }): Promise<{ id: string }> {
    const token = await this.token();
    const raw = this.buildRaw(input);
    const res = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`gmail send ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { id: string };
    return { id: json.id };
  }
}
