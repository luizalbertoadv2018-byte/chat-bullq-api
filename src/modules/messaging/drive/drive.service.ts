import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';

/**
 * Envia arquivos recebidos dos clientes para o Google Drive do escritório,
 * organizados em UMA pasta por cliente, dentro de uma pasta raiz.
 *
 * Autenticação: OAuth de usuário (refresh_token) — porque conta de serviço
 * não tem cota de armazenamento no Drive de Gmail comum. Escopo drive.file:
 * o app só enxerga/gerencia o que ELE cria (pasta raiz + pastas de cliente +
 * arquivos), nunca o resto do Drive do usuário. Least privilege.
 *
 * DESLIGADO até setar as envs GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET /
 * GDRIVE_REFRESH_TOKEN. Sem elas, isEnabled()=false e tudo é no-op.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);
  private cachedToken?: { token: string; expiresAt: number };
  private rootFolderIdCache?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get clientId() {
    return this.config.get<string>('GDRIVE_CLIENT_ID');
  }
  private get clientSecret() {
    return this.config.get<string>('GDRIVE_CLIENT_SECRET');
  }
  private get refreshToken() {
    return this.config.get<string>('GDRIVE_REFRESH_TOKEN');
  }
  private get rootFolderName() {
    return (
      this.config.get<string>('GDRIVE_ROOT_FOLDER') ??
      'Clientes — Alberto Martins'
    );
  }

  isEnabled(): boolean {
    return !!(this.clientId && this.clientSecret && this.refreshToken);
  }

  private async token(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.token;
    }
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
    if (!res.ok) {
      throw new Error(`gdrive token ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };
    this.cachedToken = {
      token: json.access_token,
      expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
    };
    return json.access_token;
  }

  /** Procura, entre os arquivos criados pelo app, uma pasta pelo nome (+ pai). */
  private async findFolder(
    name: string,
    parentId?: string,
  ): Promise<string | null> {
    const token = await this.token();
    const escaped = name.replace(/'/g, "\\'");
    const clauses = [
      `name = '${escaped}'`,
      `mimeType = '${FOLDER_MIME}'`,
      'trashed = false',
      parentId ? `'${parentId}' in parents` : "'root' in parents",
    ];
    const q = encodeURIComponent(clauses.join(' and '));
    const res = await fetch(`${FILES_URL}?q=${q}&fields=files(id,name)&pageSize=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`gdrive list ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { files?: Array<{ id: string }> };
    return data.files && data.files.length ? data.files[0].id : null;
  }

  private async createFolder(name: string, parentId?: string): Promise<string> {
    const token = await this.token();
    const res = await fetch(`${FILES_URL}?fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    });
    if (!res.ok) throw new Error(`gdrive mkdir ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  private async findOrCreateRoot(): Promise<string> {
    if (this.rootFolderIdCache) return this.rootFolderIdCache;
    const existing = await this.findFolder(this.rootFolderName);
    const id = existing ?? (await this.createFolder(this.rootFolderName));
    this.rootFolderIdCache = id;
    return id;
  }

  /**
   * Pasta do contato (cria na 1ª vez). O id fica cacheado em
   * contact.metadata.driveFolderId pra não pesquisar/criar de novo.
   */
  async findOrCreateContactFolder(
    contactId: string,
    folderName: string,
  ): Promise<string> {
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { metadata: true },
    });
    const meta = (contact?.metadata ?? {}) as Record<string, any>;
    if (typeof meta.driveFolderId === 'string' && meta.driveFolderId) {
      return meta.driveFolderId;
    }
    const root = await this.findOrCreateRoot();
    const existing = await this.findFolder(folderName, root);
    const folderId = existing ?? (await this.createFolder(folderName, root));
    await this.prisma.contact.update({
      where: { id: contactId },
      data: { metadata: { ...meta, driveFolderId: folderId } as any },
    });
    return folderId;
  }

  /** Sobe o arquivo (multipart) na pasta e devolve id + link de visualização. */
  async uploadFile(
    folderId: string,
    fileName: string,
    mimeType: string,
    bytes: Buffer,
  ): Promise<{ id: string; webViewLink: string | null }> {
    const token = await this.token();
    const boundary = `tbq-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const meta = JSON.stringify({ name: fileName, parents: [folderId] });
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
    );
    const post = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([pre, bytes, post]);

    const res = await fetch(
      `${UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    if (!res.ok) {
      throw new Error(`gdrive upload ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { id: string; webViewLink?: string };
    return { id: data.id, webViewLink: data.webViewLink ?? null };
  }
}
