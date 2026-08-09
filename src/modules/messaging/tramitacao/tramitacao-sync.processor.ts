import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { MediaResolverService } from '../messages/media-resolver.service';
import { TramitacaoService, TramCadastro } from './tramitacao.service';
import { GmailSendService } from './gmail-send.service';

/**
 * A fila `tramitacao-sync` carrega os tipos de trabalho abaixo. **NADA vai pro
 * Tramitação antes da assinatura do contrato** — o gatilho de tudo é `release`.
 *  - `media`          → espelha um arquivo recebido no cliente (por e-mail).
 *                        Só é enfileirado pra contato JÁ LIBERADO (ou no backfill).
 *  - `cpf`            → reconcilia o contato com o cliente do Tramitação por CPF
 *                        (Camada 1). Só pra contato já liberado.
 *  - `stash-cadastro` → guarda no contato o cadastro coletado no envio do
 *                        contrato (Camada 2), SEM tocar o Tramitação. Fica
 *                        pendente até a assinatura.
 *  - `release-by-doc` → assinatura confirmada (webhook ZapSign): cria/atualiza
 *                        o cliente completo, faz backfill das mídias já
 *                        recebidas e libera o fluxo do contato pra frente.
 *  - `release-by-contact` → liberação MANUAL pelo operador (cliente presencial
 *                        que não assina pela ZapSign). Mesma liberação, mas
 *                        achando o contato pelo id.
 * `kind` ausente = `media` (compat. com jobs antigos já enfileirados).
 */
export type TramitacaoSyncJob =
  | { kind?: 'media'; messageId: string; organizationId: string }
  | { kind: 'cpf'; contactId: string; organizationId: string }
  | {
      kind: 'stash-cadastro';
      organizationId: string;
      contactId: string;
      cadastro: TramCadastro;
      docToken: string;
    }
  | { kind: 'release-by-doc'; docToken: string }
  | { kind: 'release-by-contact'; contactId: string; organizationId: string };

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
    @InjectQueue('tramitacao-sync') private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<TramitacaoSyncJob>): Promise<any> {
    const data = job.data;
    const kind = (data as any).kind ?? 'media';

    // stash-cadastro só grava no nosso banco (não toca o Tramitação) — roda
    // mesmo com a integração desligada, pra o cadastro ficar pronto.
    if (kind === 'stash-cadastro') {
      return this.processStashCadastro(
        data as Extract<TramitacaoSyncJob, { kind: 'stash-cadastro' }>,
      );
    }
    // O resto fala com a API do Tramitação.
    if (kind === 'release-by-doc') {
      if (!this.tramitacao.isEnabled()) return { skipped: 'tramitacao-disabled' };
      return this.processReleaseByDoc(
        data as Extract<TramitacaoSyncJob, { kind: 'release-by-doc' }>,
      );
    }
    if (kind === 'release-by-contact') {
      if (!this.tramitacao.isEnabled()) return { skipped: 'tramitacao-disabled' };
      return this.processReleaseByContact(
        data as Extract<TramitacaoSyncJob, { kind: 'release-by-contact' }>,
      );
    }
    if (kind === 'cpf') {
      if (!this.tramitacao.isEnabled()) return { skipped: 'tramitacao-disabled' };
      return this.processCpf(data as Extract<TramitacaoSyncJob, { kind: 'cpf' }>);
    }
    return this.processMedia(data as { messageId: string; organizationId: string });
  }

  /**
   * Guarda no contato o cadastro coletado quando o agente envia o contrato,
   * junto do docToken da ZapSign. Fica PENDENTE (não vai pro Tramitação) até a
   * assinatura ser confirmada. O docToken é a chave que o webhook usa depois
   * pra achar este contato.
   */
  private async processStashCadastro(data: {
    organizationId: string;
    contactId: string;
    cadastro: TramCadastro;
    docToken: string;
  }): Promise<any> {
    const contact = await this.prisma.contact.findUnique({
      where: { id: data.contactId },
      select: { id: true, organizationId: true, metadata: true },
    });
    if (!contact || contact.organizationId !== data.organizationId) {
      return { skipped: 'contact-not-found' };
    }
    const meta = (contact.metadata ?? {}) as Record<string, any>;
    await this.prisma.contact.update({
      where: { id: contact.id },
      data: {
        metadata: {
          ...meta,
          pendingCadastro: {
            cadastro: data.cadastro as any,
            docToken: data.docToken,
          },
        } as any,
      },
    });
    this.logger.log(
      `tramitação(stash): cadastro pendente guardado p/ contato ${contact.id} (doc ${data.docToken})`,
    );
    return { stashed: true };
  }

  /**
   * Assinatura confirmada. Acha o contato pelo docToken guardado, cria/atualiza
   * o cliente COMPLETO no Tramitação, faz backfill das mídias já recebidas e
   * marca o contato como LIBERADO (dali pra frente tudo sincroniza normalmente).
   */
  private async processReleaseByDoc(data: { docToken: string }): Promise<any> {
    // Acha o contato cujo cadastro pendente aponta pra este documento.
    const contact = await this.prisma.contact.findFirst({
      where: {
        deletedAt: null,
        metadata: {
          path: ['pendingCadastro', 'docToken'],
          equals: data.docToken,
        },
      },
    });
    if (!contact) {
      this.logger.warn(
        `tramitação(release): nenhum contato pendente p/ doc ${data.docToken}`,
      );
      return { skipped: 'no-contact-for-doc' };
    }
    return this.releaseContact(contact, 'assinatura');
  }

  /** Liberação MANUAL pelo operador (cliente presencial que não assina). */
  private async processReleaseByContact(data: {
    contactId: string;
    organizationId: string;
  }): Promise<any> {
    const contact = await this.prisma.contact.findUnique({
      where: { id: data.contactId },
    });
    if (!contact || contact.organizationId !== data.organizationId) {
      return { skipped: 'contact-not-found' };
    }
    return this.releaseContact(contact, 'manual');
  }

  /**
   * Núcleo da liberação (usado pela assinatura E pelo botão manual): cria/
   * atualiza o cliente COMPLETO no Tramitação a partir do cadastro pendente +
   * campos do contato, marca LIBERADO e faz backfill das mídias já recebidas.
   * Idempotente: pushCadastro reconcilia por CPF/telefone (não duplica) e o
   * backfill pula o que já foi enviado.
   */
  private async releaseContact(
    contact: import('@prisma/client').Contact,
    origem: 'assinatura' | 'manual',
  ): Promise<any> {
    const meta = (contact.metadata ?? {}) as Record<string, any>;
    const pending = (meta.pendingCadastro ?? {}) as {
      cadastro?: TramCadastro;
      docToken?: string;
    };

    // Monta o cadastro: o coletado no contrato (se houver) + campos do contato.
    const cadastro: TramCadastro = {
      ...(pending.cadastro ?? {}),
      name: pending.cadastro?.name ?? contact.name,
      cpf: pending.cadastro?.cpf ?? contact.cpf,
      phone: pending.cadastro?.phone ?? contact.phone,
    };

    // Reusa o cliente já vinculado (se houver) — não duplica em reexecuções.
    const customer = await this.tramitacao.releaseCustomer(
      cadastro,
      meta.tramitacaoCustomerId ?? null,
    );
    if (!customer) {
      this.logger.warn(
        `tramitação(release/${origem}): não criou/achou cliente p/ contato ${contact.id} (sem nome nem CPF?)`,
      );
      return { skipped: 'push-falhou' };
    }

    // Marca liberado + guarda o cliente casado; remove o pendente.
    const { pendingCadastro, ...restMeta } = meta;
    await this.prisma.contact.update({
      where: { id: contact.id },
      data: {
        metadata: {
          ...restMeta,
          tramitacaoReleased: true,
          tramitacaoReleasedAt: new Date().toISOString(),
          tramitacaoReleasedBy: origem,
          tramitacaoCustomerId: customer.id,
          tramitacaoCustomerType: 'cliente',
        } as any,
      },
    });

    // Backfill: manda pro Tramitação TODAS as mídias que o cliente já enviou e
    // que ainda não foram espelhadas.
    const backfilled = await this.backfillMedia(contact.id, contact.organizationId);

    this.logger.log(
      `tramitação(release/${origem}): contato ${contact.id} → cliente ${customer.id}; backfill de ${backfilled} mídia(s)`,
    );
    return { released: true, customerId: customer.id, backfilled };
  }

  /**
   * Enfileira o espelhamento de todas as mídias inbound do contato ainda não
   * enviadas ao Tramitação. Reusa o próprio processor (kind media, idempotente
   * pelo flag tramitacaoSent).
   */
  private async backfillMedia(
    contactId: string,
    organizationId: string,
  ): Promise<number> {
    // Busca TODAS as mídias inbound do contato e filtra o "já enviado" no
    // código. NÃO usar `NOT { path:['tramitacaoSent'], equals:true }` na query:
    // no Postgres, mensagens sem essa chave (o caso normal) têm o path = NULL,
    // e `NOT (NULL = true)` = NULL → a linha é EXCLUÍDA. Isso zerava o backfill.
    const medias = await this.prisma.message.findMany({
      where: {
        direction: 'INBOUND',
        type: { in: ['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'STICKER'] as any },
        conversation: { contactId, organizationId },
      },
      select: { id: true, metadata: true },
      take: 1000,
    });
    let enfileiradas = 0;
    for (const m of medias) {
      const meta = (m.metadata ?? {}) as Record<string, any>;
      if (meta.tramitacaoSent === true) continue; // já espelhado
      await this.queue
        .add(
          'sync',
          { kind: 'media', messageId: m.id, organizationId },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 8000 },
            removeOnComplete: true,
            removeOnFail: 50,
          },
        )
        .then(() => {
          enfileiradas++;
        })
        .catch((err) =>
          this.logger.warn(
            `backfill enqueue falhou p/ msg ${m.id}: ${err?.message ?? err}`,
          ),
        );
    }
    return enfileiradas;
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
