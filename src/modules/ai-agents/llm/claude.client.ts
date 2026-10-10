import { InternalServerErrorException, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmContent,
  LlmImagePart,
  LlmMessage,
  LlmTextPart,
  LlmToolCall,
  LlmToolDefinition,
  LlmUsage,
} from './llm.types';

/**
 * Preço por 1M tokens (USD), só p/ registrar custo interno. Modelo fora da
 * tabela registra custo 0 — conferir em https://www.anthropic.com/pricing.
 */
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

const VISION_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type VisionMediaType = (typeof VISION_MEDIA_TYPES)[number];

const IMAGE_PLACEHOLDER =
  '[imagem enviada — não foi possível carregar pra eu visualizar]';

/**
 * Fala com a Messages API da Anthropic para agentes cujo `modelId` é
 * `claude-*`. Mesmo contrato normalizado do LlmService (que continua dono do
 * caminho OpenAI e decide para qual provider cada chamada vai).
 */
export class ClaudeClient {
  private readonly logger = new Logger(ClaudeClient.name);
  private readonly client: Anthropic;

  constructor(apiKey: string, timeoutMs: number) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs });
  }

  async complete(
    req: LlmCompletionRequest,
    tools: LlmToolDefinition[] | undefined,
  ): Promise<LlmCompletionResponse> {
    const { system, messages } = this.toClaude(req.messages);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.modelId,
      // Folga para o raciocínio, que nos modelos novos conta como output.
      max_tokens: Math.max(req.maxTokens ?? 2048, 4096),
      // `temperature` fica de fora: a família 5.x rejeita com 400.
      ...(system
        ? {
            system: [
              // O prompt do agente é idêntico entre turnos: cacheia o prefixo.
              { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
            ],
          }
        : {}),
      ...(tools && tools.length > 0
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
      messages,
    };

    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(params);
    } catch (err: unknown) {
      this.logError(err, req.modelId, tools);

      // Rede de segurança: 400 com imagem quase sempre é a URL que o provider
      // não conseguiu baixar. Refaz UMA vez só com texto.
      const stripped = this.stripImages(messages);
      if (err instanceof Anthropic.BadRequestError && stripped) {
        this.logger.warn(
          `LLM 400 com imagem no payload — retry sem os image blocks [${req.modelId}]`,
        );
        try {
          res = await this.client.messages.create({ ...params, messages: stripped });
        } catch (retryErr: unknown) {
          throw new InternalServerErrorException(
            `LLM provider error: ${this.errorMessage(retryErr)}`,
          );
        }
      } else {
        throw new InternalServerErrorException(
          `LLM provider error: ${this.errorMessage(err)}`,
        );
      }
    }

    return {
      message: this.fromClaude(res),
      stopReason: this.normalizeStopReason(res.stop_reason),
      usage: this.extractUsage(res.usage, req.modelId),
      rawModelId: res.model ?? req.modelId,
    };
  }

  // ─── conversão: nossos tipos → Anthropic ──────────────────────────

  /**
   * - system vira o parâmetro `system` (texto concatenado).
   * - tool results viram blocos `tool_result` numa mensagem `user`.
   * - mensagens consecutivas do mesmo papel são fundidas: a API exige que
   *   todos os `tool_result` de um turno venham na MESMA mensagem.
   */
  private toClaude(input: LlmMessage[]): {
    system: string;
    messages: Anthropic.MessageParam[];
  } {
    const systemParts: string[] = [];
    const out: Array<{
      role: 'user' | 'assistant';
      content: Anthropic.ContentBlockParam[];
    }> = [];

    const push = (
      role: 'user' | 'assistant',
      blocks: Anthropic.ContentBlockParam[],
    ) => {
      if (blocks.length === 0) return;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else out.push({ role, content: blocks });
    };

    for (const m of input) {
      if (m.role === 'system') {
        const text = this.textOnly(m.content);
        if (text) systemParts.push(text);
        continue;
      }

      if (m.role === 'user') {
        push('user', this.userBlocks(m.content));
        continue;
      }

      if (m.role === 'assistant') {
        const blocks: Anthropic.ContentBlockParam[] = [];
        const text = this.textOnly(m.content);
        if (text.trim()) blocks.push({ type: 'text', text });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments ?? {},
          });
        }
        push('assistant', blocks);
        continue;
      }

      if (m.role === 'tool') {
        if (!m.toolCallId) {
          this.logger.warn('Tool message without toolCallId — dropping');
          continue;
        }
        push('user', [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: this.textOnly(m.content) || '(empty)',
          },
        ]);
      }
    }

    // A API não aceita terminar em `assistant` (seria prefill): quando o
    // runner é acionado sem mensagem nova do cliente, sinalizamos a retomada.
    if (out.length > 0 && out[out.length - 1].role === 'assistant') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[sem nova mensagem do cliente — continue o atendimento]',
          },
        ],
      });
    }

    return { system: systemParts.join('\n\n'), messages: out };
  }

  private userBlocks(content: LlmContent): Anthropic.ContentBlockParam[] {
    if (typeof content === 'string') {
      return content.trim() ? [{ type: 'text', text: content }] : [];
    }
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        if (part.text && part.text.trim()) {
          blocks.push({ type: 'text', text: part.text });
        }
        continue;
      }
      if (part.type === 'image') blocks.push(this.imageBlock(part));
    }
    return blocks;
  }

  private imageBlock(part: LlmImagePart): Anthropic.ContentBlockParam {
    const inline = part.base64 ?? this.parseDataUri(part.url);
    if (inline) {
      const mediaType = inline.mediaType.split(';')[0].trim().toLowerCase();
      if (!(VISION_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
        return { type: 'text', text: IMAGE_PLACEHOLDER };
      }
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType as VisionMediaType,
          data: inline.data,
        },
      };
    }
    if (part.url) {
      return { type: 'image', source: { type: 'url', url: part.url } };
    }
    return { type: 'text', text: IMAGE_PLACEHOLDER };
  }

  /** Mídia do Evolution chega embutida como `data:<mime>;base64,<dados>`. */
  private parseDataUri(
    url: string | undefined,
  ): { mediaType: string; data: string } | null {
    if (!url || !url.startsWith('data:')) return null;
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    const header = url.slice('data:'.length, comma);
    if (!/;base64$/i.test(header)) return null;
    return {
      mediaType: header.replace(/;base64$/i, ''),
      data: url.slice(comma + 1),
    };
  }

  private textOnly(content: LlmContent): string {
    if (typeof content === 'string') return content;
    return content
      .filter((part) => part.type === 'text')
      .map((part) => (part as LlmTextPart).text)
      .join('');
  }

  // ─── conversão: Anthropic → nossos tipos ──────────────────────────

  private fromClaude(res: Anthropic.Message): LlmMessage {
    const toolCalls: LlmToolCall[] = [];
    let text = '';
    for (const block of res.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        const input = block.input;
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments:
            input && typeof input === 'object' && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
        });
      }
    }
    return {
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private normalizeStopReason(
    reason: Anthropic.Message['stop_reason'],
  ): LlmCompletionResponse['stopReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      case 'max_tokens':
        return 'length';
      case 'refusal':
        return 'content_filter';
      default:
        return 'other';
    }
  }

  private extractUsage(usage: Anthropic.Usage, model: string): LlmUsage {
    // Na Anthropic `input_tokens` já EXCLUI os tokens de cache.
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    const cacheRead = usage?.cache_read_input_tokens ?? 0;
    const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
    const p = PRICING[model];
    const costUsd = p
      ? (input * p.in +
          output * p.out +
          cacheRead * p.in * 0.1 +
          cacheWrite * p.in * 1.25) /
        1_000_000
      : 0;
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd,
    };
  }

  // ─── error handling ──────────────────────────────────────────────

  /** Troca cada bloco de imagem por marcador textual; null se não havia. */
  private stripImages(
    messages: Anthropic.MessageParam[],
  ): Anthropic.MessageParam[] | null {
    let found = false;
    const out = messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      const content = message.content.map<Anthropic.ContentBlockParam>((block) => {
        if (block.type !== 'image') return block;
        found = true;
        return { type: 'text', text: IMAGE_PLACEHOLDER };
      });
      return { ...message, content };
    });
    return found ? out : null;
  }

  private logError(
    err: unknown,
    model: string,
    tools: LlmToolDefinition[] | undefined,
  ): void {
    const status = err instanceof Anthropic.APIError ? err.status : undefined;
    const toolNames = tools?.map((t) => t.name).join(',');
    this.logger.error(
      `LLM call failed [${model}] status=${status ?? '?'}: ${this.errorMessage(err)} | tools=[${toolNames ?? ''}]`,
    );
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
