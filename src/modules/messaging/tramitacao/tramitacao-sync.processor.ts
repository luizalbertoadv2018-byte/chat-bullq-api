import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { MediaResolverService } from '../messages/media-resolver.service';
import { TramitacaoService } from './tramitacao.service';
import { GmailSendService } from './gmail-send.service';

export interface TramitacaoSyncJob {
  messageId: string;
  organizationId: string;
}

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

@Processor('tramitacao-sync', { concurrency: 2 })
export class TramitacaoSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(TramitacaoSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaResolver: MediaResolverService,
    private readonly tramitacao: TramitacaoService,
    private readonly gmail: GmailSendService,
  ) {
    super();
  }

  async process(job: Job<TramitacaoSyncJob>): Promise<any> {
    if (!this.tramitacao.isEnabled() || !this.gmail.isEnabled()) {
      return { skipped: 'tramitacao-disabled' };
    }
    const { messageId, organizationId } = job.data;

    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: { include: { contact: true } } },
    });
    if (!message || message.conversation.organizationId !== organizationId) {
      return { skipped: 'message-not-found' };
    }

    const meta = (message.metadata ?? {}) as Record<string, any>;
    if (meta.tramitacaoSent) return { skipped: 'already-sent' };

    const contact = message.conversation.contact;
    const phone = (contact.phone ?? '').trim();
    if (!phone) return { skipped: 'contato-sem-telefone' };

    // 1) acha o cliente pelo telefone; se não achar, cria um contato.
    let customer = await this.tramitacao.findByPhone(phone);
    if (!customer) {
      customer = await this.tramitacao.createContato(contact.name ?? null, phone);
    }
    if (!customer) return { skipped: 'sem-cliente' };

    // 2) garante o e-mail exclusivo.
    let email = customer.email;
    if (!email) email = await this.tramitacao.ensureEmail(customer.id);
    if (!email) return { skipped: 'sem-email-exclusivo' };

    // 3) resolve + baixa o arquivo.
    let url: string;
    let mimeType: string | undefined;
    try {
      const resolved = await this.mediaResolver.resolve(messageId, organizationId);
      url = resolved.url;
      mimeType = resolved.mimeType;
    } catch (err: any) {
      this.logger.warn(`tramitação: sem URL de mídia p/ msg ${messageId}: ${err?.message ?? err}`);
      return { skipped: 'no-media-url' };
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download da mídia falhou ${resp.status}`);
    const bytes = Buffer.from(await resp.arrayBuffer());
    const content = (message.content ?? {}) as Record<string, any>;
    const mime = mimeType || content.mimeType || 'application/octet-stream';
    const fileName = this.buildFileName(content, message.createdAt, mime);

    // 4) envia por e-mail pro endereço exclusivo (Tramitação arquiva no cliente).
    await this.gmail.sendWithAttachment({
      to: email,
      subject: `Documento recebido via WhatsApp — ${contact.name ?? phone}`,
      text: `Arquivo enviado pelo cliente ${contact.name ?? ''} (${phone}) pelo WhatsApp, encaminhado automaticamente pelo Chat BullQ.`,
      filename: fileName,
      mimeType: mime,
      bytes,
    });

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        metadata: {
          ...meta,
          tramitacaoSent: true,
          tramitacaoCustomerId: customer.id,
        } as any,
      },
    });

    this.logger.log(
      `tramitação: msg ${messageId} → cliente ${customer.id} (${email})`,
    );
    return { sent: true, customerId: customer.id };
  }

  private buildFileName(content: Record<string, any>, createdAt: Date, mimeType: string): string {
    const original =
      typeof content.fileName === 'string' && content.fileName.trim()
        ? content.fileName.trim()
        : null;
    const d = createdAt;
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (original) return `${stamp}_${original.replace(/[\\/:*?"<>|]/g, ' ').trim()}`;
    const ext = EXT[mimeType] ?? 'bin';
    return `${stamp}_documento.${ext}`;
  }
}
