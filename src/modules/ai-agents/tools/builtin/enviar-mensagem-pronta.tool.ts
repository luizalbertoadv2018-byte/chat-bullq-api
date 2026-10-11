import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

interface QuickReplyAttachment {
  url?: string;
  type?: string;
  fileName?: string;
  mimeType?: string;
}

const MEDIA_TYPES: Record<string, MessageContentType> = {
  IMAGE: MessageContentType.IMAGE,
  VIDEO: MessageContentType.VIDEO,
  DOCUMENT: MessageContentType.DOCUMENT,
  AUDIO: MessageContentType.AUDIO,
};

/**
 * Envia ao cliente uma "mensagem pronta" cadastrada no painel (texto e/ou
 * mídia), escolhida pelo atalho. É o jeito do agente mandar IMAGEM/arquivo:
 * o operador cadastra a arte uma vez e o agente dispara quando fizer sentido.
 * Passa pela mesma fila de saída das mensagens manuais.
 */
@Injectable()
export class EnviarMensagemProntaTool implements AiTool {
  private readonly logger = new Logger(EnviarMensagemProntaTool.name);

  readonly name = 'enviarMensagemPronta';
  readonly description =
    'Envia ao cliente uma mensagem pronta do escritório (imagem, arquivo e/ou texto já cadastrados no painel), escolhida pelo "atalho". ' +
    'Use quando o roteiro indicar um material pronto (ex.: a arte com os contatos oficiais). ' +
    'Se não souber o atalho, chame com atalho "?" para listar os disponíveis. Não substitui a sua resposta em texto quando o cliente fez uma pergunta.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['atalho'],
    properties: {
      atalho: {
        type: 'string',
        description: 'Atalho da mensagem pronta (ex.: "contatos"). Use "?" para listar.',
        maxLength: 80,
      },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  private norm(s: string): string {
    return (s ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/^\//, '')
      .trim();
  }

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const alvo = this.norm(String(input.atalho ?? ''));

    const prontas = await this.prisma.quickReply.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      select: { shortcut: true, title: true, content: true, attachments: true },
    });
    const disponiveis = prontas.map((p) => ({ atalho: p.shortcut, titulo: p.title }));

    if (!alvo || alvo === '?') {
      return { output: { ok: true, disponiveis } };
    }

    const pronta =
      prontas.find((p) => this.norm(p.shortcut) === alvo) ??
      prontas.find((p) => this.norm(p.shortcut).includes(alvo));
    if (!pronta) {
      return {
        output: {
          ok: false,
          error: `Não existe mensagem pronta com o atalho "${input.atalho}".`,
          disponiveis,
        },
      };
    }

    const [agent, contactChannel] = await Promise.all([
      this.prisma.aiAgent.findUnique({
        where: { id: ctx.agentId },
        select: { name: true },
      }),
      this.prisma.contactChannel.findFirst({
        where: { contactId: ctx.contactId, channelId: ctx.channelId },
        select: { externalId: true },
      }),
    ]);
    if (!contactChannel?.externalId) {
      return {
        output: { ok: false, error: 'Contact has no external id on this channel' },
      };
    }

    const text = (pronta.content ?? '').trim();
    const attachments = (
      Array.isArray(pronta.attachments) ? pronta.attachments : []
    ) as QuickReplyAttachment[];
    const media = attachments.filter(
      (a) => a?.url && MEDIA_TYPES[String(a.type ?? '').toUpperCase()],
    );

    // Uma mensagem por anexo; o texto vai como legenda do primeiro. Sem
    // anexo, vira uma mensagem de texto simples.
    const outgoing: Array<{
      type: MessageContentType;
      content: Record<string, unknown>;
    }> = media.map((a, i) => ({
      type: MEDIA_TYPES[String(a.type).toUpperCase()],
      content: {
        mediaUrl: a.url,
        ...(a.mimeType ? { mimeType: a.mimeType } : {}),
        ...(a.fileName ? { fileName: a.fileName } : {}),
        ...(i === 0 && text ? { caption: text } : {}),
      },
    }));
    if (outgoing.length === 0) {
      if (!text) {
        return {
          output: { ok: false, error: 'A mensagem pronta está vazia (sem texto e sem anexo).' },
        };
      }
      outgoing.push({ type: MessageContentType.TEXT, content: { text } });
    }

    const messageIds: string[] = [];
    for (const item of outgoing) {
      const message = await this.prisma.message.create({
        data: {
          conversationId: ctx.conversationId,
          direction: MessageDirection.OUTBOUND,
          type: item.type,
          content: item.content as any,
          status: MessageStatus.QUEUED,
          senderName: agent?.name ?? 'AI',
          metadata: {
            aiAgentId: ctx.agentId,
            runId: ctx.runId,
            quickReply: pronta.shortcut,
          },
        },
      });
      messageIds.push(message.id);

      this.realtime.emitToChannel(ctx.channelId, 'message:new', {
        message,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
      });
      this.realtime.emitToConversation(ctx.conversationId, 'message:new', {
        message,
      });

      await this.outboundQueue.add(
        'send-outbound',
        {
          messageId: message.id,
          channelId: ctx.channelId,
          contactExternalId: contactChannel.externalId,
          message: { type: item.type, content: item.content },
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    await this.prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { lastMessageAt: new Date() },
    });

    this.logger.log(
      `Agent ${ctx.agentId} enviou a mensagem pronta "${pronta.shortcut}" na conv ${ctx.conversationId} (${messageIds.length} msg)`,
    );

    return {
      output: { ok: true, enviada: pronta.shortcut, mensagens: messageIds.length },
      finalAction: 'REPLIED',
    };
  }
}
