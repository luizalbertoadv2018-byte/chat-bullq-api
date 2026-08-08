import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { MediaResolverService } from '../messages/media-resolver.service';
import { DriveService } from './drive.service';

export interface DriveSyncJob {
  messageId: string;
  organizationId: string;
}

/** Extensão a partir do mime, pra dar um nome de arquivo decente. */
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
};

@Processor('drive-sync', { concurrency: 3 })
export class DriveSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(DriveSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaResolver: MediaResolverService,
    private readonly drive: DriveService,
  ) {
    super();
  }

  async process(job: Job<DriveSyncJob>): Promise<any> {
    if (!this.drive.isEnabled()) return { skipped: 'drive-disabled' };
    const { messageId, organizationId } = job.data;

    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        conversation: { include: { contact: true } },
      },
    });
    if (!message || message.conversation.organizationId !== organizationId) {
      return { skipped: 'message-not-found' };
    }

    // Idempotência: já subiu esse arquivo → não repete.
    const meta = (message.metadata ?? {}) as Record<string, any>;
    if (meta.driveFileId) return { skipped: 'already-synced' };

    // Resolve URL playable + baixa os bytes.
    let url: string;
    let mimeType: string | undefined;
    try {
      const resolved = await this.mediaResolver.resolve(messageId, organizationId);
      url = resolved.url;
      mimeType = resolved.mimeType;
    } catch (err: any) {
      this.logger.warn(
        `drive: sem URL de mídia p/ msg ${messageId}: ${err?.message ?? err}`,
      );
      return { skipped: 'no-media-url' };
    }

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`download da mídia falhou ${resp.status}`);
    }
    const bytes = Buffer.from(await resp.arrayBuffer());
    const content = (message.content ?? {}) as Record<string, any>;
    const mime: string =
      mimeType || content.mimeType || 'application/octet-stream';

    const contact = message.conversation.contact;
    const folderName = this.buildFolderName(contact);
    const fileName = this.buildFileName(content, message.createdAt, mime);

    const folderId = await this.drive.findOrCreateContactFolder(
      contact.id,
      folderName,
    );
    const uploaded = await this.drive.uploadFile(
      folderId,
      fileName,
      mime,
      bytes,
    );

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        metadata: {
          ...meta,
          driveFileId: uploaded.id,
          driveWebViewLink: uploaded.webViewLink,
        } as any,
      },
    });

    this.logger.log(
      `drive: msg ${messageId} → ${folderName}/${fileName} (${uploaded.id})`,
    );
    return { uploaded: uploaded.id, folder: folderName };
  }

  private buildFolderName(contact: {
    name: string | null;
    phone: string | null;
    id: string;
  }): string {
    const name = (contact.name ?? '').trim();
    const phone = (contact.phone ?? '').trim();
    let base: string;
    if (name && phone) base = `${name} - ${phone}`;
    else base = name || phone || `Cliente ${contact.id.slice(-6)}`;
    // Remove caracteres inválidos p/ nome de pasta.
    return base.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private buildFileName(
    content: Record<string, any>,
    createdAt: Date,
    mimeType: string,
  ): string {
    const original =
      typeof content.fileName === 'string' && content.fileName.trim()
        ? content.fileName.trim()
        : null;
    const d = createdAt;
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
    if (original) {
      const clean = original.replace(/[\\/:*?"<>|]/g, ' ').trim();
      return `${stamp}_${clean}`;
    }
    const ext = EXT[mimeType] ?? 'bin';
    return `${stamp}_arquivo.${ext}`;
  }
}
