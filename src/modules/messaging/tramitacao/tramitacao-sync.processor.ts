import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { MediaResolverService } from '../messages/media-resolver.service';
import { TramitacaoService, TramCadastro } from './tramitacao.service';
import { GmailSendService } from './gmail-send.service';

/**
 * A fila `tramitacao-sync` carrega 3 tipos de trabalho:
 *  - `media`    → espelha um arquivo recebido no cliente (por e-mail);
 *  - `cpf`      → reconcilia o contato com o cliente do Tramitação por CPF
 *                 (Camada 1 — casamento exato, upgrade contato→cliente);
 *  - `cadastro` → empurra um cadastro completo (Camada 2 — dados do ZapSign).
 * `kind` ausente = `media` (compat. com jobs antigos já enfileirados).
 */
export type TramitacaoSyncJob =
  | { kind?: 'media'; messageId: string; organizationId: string }
  | { kind: 'cpf'; contactId: string; organizationId: string }
  | {
      kind: 'cadastro';
      organizationId: string;
      contactId?: string;
      cadastro: TramCadastro;
    };

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
    const data = job.data;
    const kind = (data as any).kind ?? 'media';

    // CPF e cadastro só falam com a API do Tramitação (não enviam e-mail).
    if (kind === 'cpf') {
      if (!this.tramitacao.isEnabled()) return { skipped: 'tramitacao-disabled' };
      return this.processCpf(data as Extract<TramitacaoSyncJob, { kind: 'cpf' }>);
    }
    if (kind === 'cadastro') {
      if (!this.tramitacao.isEnabled()) return { skipped: 'tramitacao-disabled' };
      return this.processCadastro(
        data as Extract<TramitacaoSyncJob, { kind: 'cadastro' }>,
      );
    }
    return this.processMedia(data as { messageId: string; organizationId: string });
  }

  /**
   * Camada 1 — casa o contato com o cliente do Tramitação pelo CPF. Faz o
   * upgrade contato→cliente sem duplicar e guarda o id casado no contato
   * (metadata.tramitacaoCustomerId) pra a esteira de mídia reusar.
   */
  private async processCpf(data: {
    contactId: string;
    organizationId: string;
  }): Promise<any> {
    const contact = await this.prisma.contact.findUnique({
      where: { id: data.contactId },
    });
    if (!contact || contact.organizationId !== data.organizationId) {
      return { skipped: 'contact-not-found' };
    }
    if (!contact.cpf) return { skipped: 'sem-cpf' };

    const meta = (contact.metadata ?? {}) as Record<string, any>;
    const customer = await this.tramitacao.reconcileByCpf({
      cpf: contact.cpf,
      name: contact.name,
      phone: contact.phone,
      linkedCustomerId: meta.tramitacaoCustomerId ?? null,
    });
    if (!customer) return { skipped: 'reconcile-falhou' };

    await this.prisma.contact.update({
      where: { id: contact.id },
      data: {
        metadata: {
          ...meta,
          tramitacaoCustomerId: customer.id,
          tramitacaoCustomerType: 'cliente',
        } as any,
      },
    });
    this.logger.log(
      `tramitação(cpf): contato ${contact.id} → cliente ${customer.id}`,
    );
    return { reconciled: true, customerId: customer.id };
  }

  /**
   * Camada 2 — empurra o cadastro completo (dados do ZapSign) pro Tramitação e
   * vincula ao contato, se o job trouxe contactId.
   */
  private async processCadastro(data: {
    organizationId: string;
    contactId?: string;
    cadastro: TramCadastro;
  }): Promise<any> {
    const customer = await this.tramitacao.pushCadastro(data.cadastro);
    if (!customer) return { skipped: 'cadastro-incompleto' };

    if (data.contactId) {
      const contact = await this.prisma.contact.findUnique({
        where: { id: data.contactId },
      });
      if (contact && contact.organizationId === data.organizationId) {
        const meta = (contact.metadata ?? {}) as Record<string, any>;
        const cpf = (this.cadastroCpf(data.cadastro) ?? contact.cpf) || null;
        await this.prisma.contact.update({
          where: { id: contact.id },
          data: {
            ...(cpf && !contact.cpf ? { cpf } : {}),
            metadata: {
              ...meta,
              tramitacaoCustomerId: customer.id,
              tramitacaoCustomerType: 'cliente',
            } as any,
          },
        });
      }
    }
    this.logger.log(`tramitação(cadastro): cliente ${customer.id} atualizado`);
    return { pushed: true, customerId: customer.id };
  }

  private cadastroCpf(cad: TramCadastro): string | null {
    const d = (cad.cpf ?? '').replace(/\D/g, '');
    return d.length === 11 ? d : null;
  }

  private async processMedia(data: {
    messageId: string;
    organizationId: string;
  }): Promise<any> {
    if (!this.tramitacao.isEnabled() || !this.gmail.isEnabled()) {
      return { skipped: 'tramitacao-disabled' };
    }
    const { messageId, organizationId } = data;

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

    // 1) resolve o cliente: prefere o já casado por CPF (Camada 1); senão
    //    acha pelo telefone; senão cria um contato.
    const contactMeta = (contact.metadata ?? {}) as Record<string, any>;
    const customer = await this.tramitacao.resolveForMedia({
      linkedCustomerId: contactMeta.tramitacaoCustomerId ?? null,
      name: contact.name,
      phone,
    });
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
