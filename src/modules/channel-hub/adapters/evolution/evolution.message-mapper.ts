import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  NormalizedOutboundMessage,
  NormalizedMessageContent,
  MessageContentType,
  StatusUpdate,
} from '../../ports/types';

/**
 * Mapper da Evolution API v2 (baileys). O webhook entrega o envelope cru do
 * WhatsApp em `data.message` (conversation / extendedTextMessage / imageMessage
 * / ...). Aqui traduzimos ↔ nossos tipos normalizados.
 */
@Injectable()
export class EvolutionMessageMapper {
  private stripJid(jid: string): string {
    return (jid || '').replace(/@s\.whatsapp\.net|@g\.us|@lid/g, '');
  }

  normalizeInbound(data: any): NormalizedInboundMessage | null {
    const key = data?.key;
    const message = data?.message;
    if (!key || !message) return null;

    const remoteJid: string = key.remoteJid || '';
    const isGroup = remoteJid.endsWith('@g.us');
    const isEcho = key.fromMe === true;
    const phone = this.stripJid(remoteJid);

    // Em grupo, quem enviou vem em key.participant / data.participant.
    const participantName = data.pushName?.trim();

    const { type, content } = this.extractEnvelope(message, data);

    const result: NormalizedInboundMessage = {
      externalMessageId: key.id || '',
      externalContactId: remoteJid,
      // 1:1 inbound → pushName é o contato. Echo (fromMe) → é a gente, não usa.
      contactName: isGroup ? undefined : isEcho ? undefined : participantName,
      contactPhone: isGroup ? undefined : phone,
      channelType: ChannelType.WHATSAPP_EVOLUTION,
      timestamp: this.tsToDate(data.messageTimestamp),
      type,
      content,
      isGroup,
      isEcho,
      senderName: isGroup ? participantName : isEcho ? participantName : undefined,
      rawPayload: data,
    };

    const replyTo = this.extractReply(message);
    if (replyTo) result.replyTo = replyTo;

    return result;
  }

  /** messages.update → StatusUpdate (ack de envio/entrega/leitura). */
  normalizeStatus(data: any): StatusUpdate | null {
    if (!data) return null;
    const externalMessageId = String(
      data.keyId || data.key?.id || data.id || '',
    );
    if (!externalMessageId) return null;

    const stringMap: Record<string, StatusUpdate['status']> = {
      pending: 'sent',
      server_ack: 'sent',
      sent: 'sent',
      delivery_ack: 'delivered',
      delivered: 'delivered',
      read: 'read',
      read_ack: 'read',
      played: 'read',
      error: 'failed',
      failed: 'failed',
    };
    const numericMap: Record<number, StatusUpdate['status']> = {
      1: 'sent',
      2: 'delivered',
      3: 'read',
      4: 'read',
      5: 'failed',
    };

    let status: StatusUpdate['status'] | undefined;
    if (typeof data.status === 'number') status = numericMap[data.status];
    else status = stringMap[String(data.status || '').toLowerCase()];
    if (!status) return null;

    return {
      externalMessageId,
      status,
      timestamp: this.tsToDate(data.messageTimestamp || data.timestamp),
    };
  }

  denormalize(
    message: NormalizedOutboundMessage,
    contactExternalId: string,
  ): { endpoint: string; payload: Record<string, any> } {
    const number = this.stripJid(contactExternalId);
    const isGroupTarget = contactExternalId.endsWith('@g.us');

    const replyId = message.replyTo?.externalMessageId;
    const quoted = replyId ? { key: { id: replyId } } : undefined;

    // Menção em grupo.
    const rawMentions = message.content.mentions;
    const mentionExtras: Record<string, any> = {};
    if (isGroupTarget && rawMentions) {
      if (rawMentions === 'all') mentionExtras.mentionsEveryOne = true;
      else {
        const jids = [
          ...new Set(rawMentions.map((m) => String(m).replace(/\D/g, ''))),
        ]
          .filter(Boolean)
          .map((n) => `${n}@s.whatsapp.net`);
        if (jids.length) mentionExtras.mentioned = jids;
      }
    }

    const base = (p: Record<string, any>) => ({
      ...p,
      ...(quoted ? { quoted } : {}),
      ...mentionExtras,
    });

    const c = message.content;
    switch (message.type) {
      case MessageContentType.TEXT:
        return {
          endpoint: '/message/sendText',
          payload: base({ number, text: c.text ?? '' }),
        };
      case MessageContentType.IMAGE:
        return {
          endpoint: '/message/sendMedia',
          payload: base({
            number,
            mediatype: 'image',
            media: c.mediaUrl,
            caption: c.caption || '',
          }),
        };
      case MessageContentType.VIDEO:
        return {
          endpoint: '/message/sendMedia',
          payload: base({
            number,
            mediatype: 'video',
            media: c.mediaUrl,
            caption: c.caption || '',
          }),
        };
      case MessageContentType.DOCUMENT:
        return {
          endpoint: '/message/sendMedia',
          payload: base({
            number,
            mediatype: 'document',
            media: c.mediaUrl,
            fileName: c.fileName || 'documento',
            caption: c.caption || '',
          }),
        };
      case MessageContentType.AUDIO:
        return {
          endpoint: '/message/sendWhatsAppAudio',
          payload: base({ number, audio: c.mediaUrl }),
        };
      case MessageContentType.STICKER:
        return {
          endpoint: '/message/sendSticker',
          payload: base({ number, sticker: c.mediaUrl }),
        };
      case MessageContentType.LOCATION:
        return {
          endpoint: '/message/sendLocation',
          payload: base({
            number,
            latitude: c.latitude,
            longitude: c.longitude,
            name: c.text || '',
            address: '',
          }),
        };
      case MessageContentType.REACTION:
        return {
          endpoint: '/message/sendReaction',
          payload: {
            key: {
              remoteJid: contactExternalId,
              fromMe: false,
              id: c.reaction?.targetMessageId,
            },
            reaction: c.reaction?.emoji ?? '',
          },
        };
      default:
        return {
          endpoint: '/message/sendText',
          payload: base({ number, text: c.text ?? '' }),
        };
    }
  }

  // ─── envelope baileys → nossos tipos ──────────────────────────────

  private extractEnvelope(
    message: any,
    data: any,
  ): { type: MessageContentType; content: NormalizedMessageContent } {
    // base64 da mídia quando a instância manda com webhook base64:true.
    const b64: string | undefined = data?.message?.base64 || data?.base64;
    const asDataUri = (mime?: string) =>
      b64
        ? b64.startsWith('data:')
          ? b64
          : `data:${mime || 'application/octet-stream'};base64,${b64}`
        : undefined;

    if (typeof message.conversation === 'string') {
      return { type: MessageContentType.TEXT, content: { text: message.conversation } };
    }
    if (message.extendedTextMessage) {
      return {
        type: MessageContentType.TEXT,
        content: { text: message.extendedTextMessage.text || '' },
      };
    }
    if (message.imageMessage) {
      const m = message.imageMessage;
      return {
        type: MessageContentType.IMAGE,
        content: {
          mediaUrl: asDataUri(m.mimetype) || m.url,
          mediaId: data?.key?.id,
          mimeType: m.mimetype,
          fileSize: Number(m.fileLength) || undefined,
          caption: m.caption,
        },
      };
    }
    if (message.videoMessage || message.ptvMessage) {
      const m = message.videoMessage || message.ptvMessage;
      return {
        type: MessageContentType.VIDEO,
        content: {
          mediaUrl: asDataUri(m.mimetype) || m.url,
          mediaId: data?.key?.id,
          mimeType: m.mimetype || 'video/mp4',
          fileSize: Number(m.fileLength) || undefined,
          caption: m.caption,
        },
      };
    }
    if (message.audioMessage) {
      const m = message.audioMessage;
      return {
        type: MessageContentType.AUDIO,
        content: {
          mediaUrl: asDataUri(m.mimetype) || m.url,
          mediaId: data?.key?.id,
          mimeType: m.mimetype,
          fileSize: Number(m.fileLength) || undefined,
        },
      };
    }
    if (message.documentMessage || message.documentWithCaptionMessage) {
      const m =
        message.documentMessage ||
        message.documentWithCaptionMessage?.message?.documentMessage;
      return {
        type: MessageContentType.DOCUMENT,
        content: {
          mediaUrl: asDataUri(m?.mimetype) || m?.url,
          mediaId: data?.key?.id,
          mimeType: m?.mimetype,
          fileName: m?.fileName,
          fileSize: Number(m?.fileLength) || undefined,
          caption: m?.caption,
        },
      };
    }
    if (message.stickerMessage) {
      const m = message.stickerMessage;
      return {
        type: MessageContentType.STICKER,
        content: {
          mediaUrl: asDataUri(m.mimetype) || m.url,
          mediaId: data?.key?.id,
          mimeType: m.mimetype,
        },
      };
    }
    if (message.locationMessage) {
      const m = message.locationMessage;
      return {
        type: MessageContentType.LOCATION,
        content: {
          latitude: m.degreesLatitude,
          longitude: m.degreesLongitude,
          text: m.name || m.address,
        },
      };
    }
    if (message.reactionMessage) {
      const m = message.reactionMessage;
      return {
        type: MessageContentType.REACTION,
        content: {
          reaction: { emoji: m.text || '', targetMessageId: m.key?.id || '' },
        },
      };
    }

    // Fallback legível.
    const fallback =
      message.buttonsResponseMessage?.selectedButtonId ||
      message.listResponseMessage?.title ||
      message.templateButtonReplyMessage?.selectedId ||
      '[mensagem não suportada]';
    return { type: MessageContentType.TEXT, content: { text: String(fallback) } };
  }

  private extractReply(
    message: any,
  ): { externalMessageId: string; previewText?: string } | null {
    const ctx =
      message?.extendedTextMessage?.contextInfo ||
      message?.imageMessage?.contextInfo ||
      message?.videoMessage?.contextInfo ||
      message?.documentMessage?.contextInfo ||
      message?.audioMessage?.contextInfo;
    const id = ctx?.stanzaId || ctx?.stanzaID;
    if (!id) return null;
    const q = ctx?.quotedMessage;
    const preview =
      q?.conversation ||
      q?.extendedTextMessage?.text ||
      q?.imageMessage?.caption ||
      (q?.imageMessage ? '[imagem]' : undefined) ||
      (q?.audioMessage ? '[áudio]' : undefined) ||
      (q?.videoMessage ? '[vídeo]' : undefined) ||
      (q?.documentMessage ? '[documento]' : undefined);
    return preview
      ? { externalMessageId: id, previewText: String(preview) }
      : { externalMessageId: id };
  }

  private tsToDate(ts: any): Date {
    const num = typeof ts === 'string' ? parseInt(ts, 10) : Number(ts);
    if (!num || Number.isNaN(num)) return new Date();
    return new Date(num > 9999999999 ? num : num * 1000);
  }
}
