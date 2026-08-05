import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmContent,
  LlmContentPart,
  LlmMessage,
  LlmTextPart,
  LlmToolCall,
  LlmToolDefinition,
  LlmUsage,
} from './llm.types';
import { LLM_CONVERSATION_MODEL, LLM_SIMPLE_MODEL } from './llm.constants';

/** Preço por 1M tokens (USD). cacheRead ≈ 0.1x input, cacheWrite ≈ 1.25x input. */
const PRICING: Record<
  string,
  { in: number; out: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-fable-5': { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
};

/** Modelos que REJEITAM temperature/top_p (400). Não enviamos sampling neles. */
const NO_SAMPLING = new Set([
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-fable-5',
]);

/**
 * Cliente LLM normalizado — fala com a API da Anthropic (Claude).
 *
 * Mantém o contrato público usado pelo runner, classifier, memória, RAG e
 * evals (`complete()`, `LlmMessage`, `LlmToolDefinition`). Converte nossos
 * tipos ↔ Messages API da Anthropic. IDs legados de Sakana (`sakana/fugu*`)
 * são mapeados para Claude em vez de quebrar agentes antigos.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client: Anthropic;
  private readonly hasApiKey: boolean;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    const timeout = Number(
      config.get<string>('ANTHROPIC_TIMEOUT_MS') ?? 120_000,
    );

    this.hasApiKey = !!apiKey;
    if (!apiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY not set — AI agents will fail at runtime',
      );
    }

    this.client = new Anthropic({
      apiKey: apiKey ?? 'missing',
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
    });
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (!this.hasApiKey) {
      throw new InternalServerErrorException('ANTHROPIC_API_KEY not set');
    }

    const model = this.normalizeModelId(req.modelId);
    const { system, messages } = this.toAnthropic(req.messages);
    if (messages.length === 0) {
      throw new BadRequestException('LLM request has no user/assistant messages');
    }
    const tools = req.tools
      ? this.toAnthropicTools(this.sanitizeTools(req.tools))
      : undefined;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: req.maxTokens ?? 2048,
      messages,
      ...(system ? { system } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(this.acceptsSampling(model)
        ? { temperature: req.temperature ?? 0.7 }
        : {}),
      ...(this.sanitizeModelParams(req.modelParams) as object),
    };

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params);
    } catch (err: unknown) {
      this.logError(err, model, tools);

      // Rede de segurança: 400 com imagem quase sempre é o provider não
      // conseguindo baixar/decodificar a URL. Perder a visão de uma imagem
      // velha é melhor que o agente não responder — refaz UMA vez só com texto.
      const stripped = this.stripImageParts(messages);
      if (this.errorStatus(err) === 400 && stripped) {
        this.logger.warn(
          `LLM 400 com imagem no payload — retry sem os image blocks [${model}]`,
        );
        try {
          response = await this.client.messages.create({
            ...params,
            messages: stripped,
          });
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

    const message = this.fromAnthropic(response);
    const stopReason = this.normalizeStopReason(response.stop_reason);
    const usage = this.extractUsage(response.usage, model);

    return {
      message,
      stopReason,
      usage,
      rawModelId: response.model ?? model,
    };
  }

  // ─── conversão: nossos tipos → Anthropic Messages API ─────────────

  /**
   * Aceita IDs Claude (`claude-*`). IDs legados de Sakana são mapeados p/
   * Claude p/ não quebrar agentes antigos gravados no banco.
   */
  private normalizeModelId(id: string): string {
    const trimmed = (id ?? '').trim();
    if (!trimmed) throw new BadRequestException('modelId is required');
    if (trimmed.startsWith('claude-')) return trimmed;
    if (trimmed.startsWith('anthropic/')) {
      return trimmed.slice('anthropic/'.length);
    }
    // Legado Sakana → equivalente Claude.
    if (trimmed.includes('ultra')) return LLM_CONVERSATION_MODEL;
    if (trimmed.includes('fugu') || trimmed.startsWith('sakana')) {
      return LLM_SIMPLE_MODEL;
    }
    this.logger.warn(
      `modelId desconhecido "${trimmed}" — usando ${LLM_CONVERSATION_MODEL}`,
    );
    return LLM_CONVERSATION_MODEL;
  }

  private acceptsSampling(model: string): boolean {
    return !NO_SAMPLING.has(model);
  }

  /**
   * Converte `LlmMessage[]` para o formato da Anthropic:
   *  - system vira um parâmetro separado (array de text blocks, com
   *    cache_control no último bloco — o prefixo estável é reaproveitado).
   *  - tool results (role 'tool') viram blocos `tool_result` dentro de uma
   *    mensagem `user`, agrupando resultados consecutivos.
   */
  private toAnthropic(input: LlmMessage[]): {
    system?: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
  } {
    const systemParts: LlmTextPart[] = [];
    const messages: Anthropic.MessageParam[] = [];
    // Carrier = a última mensagem user criada só p/ carregar tool_results,
    // p/ agrupar vários resultados numa mensagem só.
    let toolCarrier: { role: 'user'; content: Anthropic.ContentBlockParam[] } | null =
      null;

    for (const m of input) {
      if (m.role === 'system') {
        for (const p of this.textParts(m.content)) {
          if (p.text) systemParts.push(p);
        }
        continue;
      }

      if (m.role === 'user') {
        const content = this.userContent(m.content);
        if (this.isEmptyContent(content)) continue;
        messages.push({ role: 'user', content } as Anthropic.MessageParam);
        toolCarrier = null;
        continue;
      }

      if (m.role === 'assistant') {
        const blocks: Anthropic.ContentBlockParam[] = [];
        const text = this.textOnly(m.content);
        if (text) blocks.push({ type: 'text', text });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments ?? {},
          });
        }
        if (blocks.length === 0) continue;
        messages.push({ role: 'assistant', content: blocks });
        toolCarrier = null;
        continue;
      }

      if (m.role === 'tool') {
        if (!m.toolCallId) {
          this.logger.warn('Tool message without toolCallId — dropping');
          continue;
        }
        const block: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: this.textOnly(m.content) || '(empty)',
        };
        if (toolCarrier) {
          toolCarrier.content.push(block);
        } else {
          toolCarrier = { role: 'user', content: [block] };
          messages.push(toolCarrier);
        }
      }
    }

    let system: Anthropic.TextBlockParam[] | undefined;
    if (systemParts.length > 0) {
      const blocks: Anthropic.TextBlockParam[] = systemParts.map((p) => ({
        type: 'text',
        text: p.text,
      }));
      // Cacheia o prefixo estável (system + tools): cache_control no último
      // bloco do system. ~90% de economia no 2º turno da mesma conversa.
      blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
      system = blocks;
    }

    return { system, messages };
  }

  private userContent(content: LlmContent): string | Anthropic.ContentBlockParam[] {
    if (typeof content === 'string') return content;

    const parts: Anthropic.ContentBlockParam[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        if (part.text && part.text.length > 0) {
          parts.push({ type: 'text', text: part.text });
        }
        continue;
      }
      if (part.type === 'image') {
        const source = this.imageSource(part);
        if (source) parts.push({ type: 'image', source });
      }
    }

    if (parts.length === 0) return '';
    return parts;
  }

  private imageSource(
    part: Extract<LlmContentPart, { type: 'image' }>,
  ): Anthropic.ImageBlockParam['source'] | null {
    if (part.url) return { type: 'url', url: part.url };
    if (part.base64) {
      return {
        type: 'base64',
        media_type: part.base64
          .mediaType as Anthropic.Base64ImageSource['media_type'],
        data: part.base64.data,
      };
    }
    return null;
  }

  private isEmptyContent(content: unknown): boolean {
    if (typeof content === 'string') return content.length === 0;
    if (Array.isArray(content)) return content.length === 0;
    return content == null;
  }

  private textParts(content: LlmContent): LlmTextPart[] {
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }
    return content.filter((p): p is LlmTextPart => p.type === 'text');
  }

  private textOnly(content: LlmContent): string {
    if (typeof content === 'string') return content;
    return content
      .filter((part) => part.type === 'text')
      .map((part) => (part as LlmTextPart).text)
      .join('');
  }

  private sanitizeTools(tools: LlmToolDefinition[]): LlmToolDefinition[] {
    const valid: LlmToolDefinition[] = [];
    for (const t of tools) {
      const reason = this.validateToolSchema(t);
      if (reason) {
        this.logger.warn(`Dropping tool ${t.name} from LLM request: ${reason}`);
        continue;
      }
      valid.push(t);
    }
    return valid;
  }

  private validateToolSchema(t: LlmToolDefinition): string | null {
    if (!t.name || typeof t.name !== 'string') return 'missing name';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) {
      return `invalid name "${t.name}" — must match [a-zA-Z0-9_-]{1,64}`;
    }
    if (!t.description || typeof t.description !== 'string') {
      return 'missing description';
    }
    const p = t.parameters as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return 'parameters not an object';
    if (p.type !== 'object') {
      return `parameters.type must be "object", got ${JSON.stringify(p.type)}`;
    }
    if (p.properties && typeof p.properties !== 'object') {
      return 'parameters.properties must be an object';
    }
    return null;
  }

  private toAnthropicTools(tools: LlmToolDefinition[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  /**
   * Passa só overrides compatíveis com a Messages API. Campos antigos
   * (OpenAI-style ou thinking custom) são ignorados sem quebrar runs.
   */
  private sanitizeModelParams(
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!params) return {};
    const allowed = new Set(['top_p', 'top_k', 'stop_sequences', 'metadata']);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k === 'stop' && v !== undefined) {
        out.stop_sequences = v;
        continue;
      }
      if (allowed.has(k)) out[k] = v;
    }
    return out;
  }

  // ─── conversão: Anthropic → nossos tipos ──────────────────────────

  private fromAnthropic(response: Anthropic.Message): LlmMessage {
    const toolCalls: LlmToolCall[] = [];
    let text = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        const input =
          block.input && typeof block.input === 'object' && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {};
        toolCalls.push({ id: block.id, name: block.name, arguments: input });
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

  private extractUsage(usage: Anthropic.Usage | undefined, model: string): LlmUsage {
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    const cacheRead = usage?.cache_read_input_tokens ?? 0;
    const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
    const costUsd = this.calculateCost(model, {
      input,
      output,
      cacheRead,
      cacheWrite,
    });

    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd,
    };
  }

  /**
   * `input_tokens` da Anthropic já é o input NÃO-cacheado; cache read/write
   * vêm em campos separados. Preço por modelo na tabela PRICING.
   */
  private calculateCost(
    model: string,
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  ): number {
    const p = PRICING[model];
    if (!p) return 0;
    return (
      (tokens.input * p.in +
        tokens.output * p.out +
        tokens.cacheRead * p.cacheRead +
        tokens.cacheWrite * p.cacheWrite) /
      1_000_000
    );
  }

  // ─── error handling ──────────────────────────────────────────────

  private logError(
    err: unknown,
    model: string,
    tools: Anthropic.Tool[] | undefined,
  ): void {
    const status = this.errorStatus(err);
    const message = this.errorMessage(err);
    const toolNames = tools?.map((t) => t.name).join(',');
    this.logger.error(
      `LLM call failed [${model}] status=${status ?? '?'}: ${message} | tools=[${toolNames ?? ''}]`,
    );
  }

  /** Troca cada bloco de imagem por um marcador textual; null se não havia. */
  private stripImageParts(
    messages: Anthropic.MessageParam[],
  ): Anthropic.MessageParam[] | null {
    let found = false;
    const out = messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      const parts = (message.content as Anthropic.ContentBlockParam[]).map(
        (part) => {
          if (part?.type !== 'image') return part;
          found = true;
          return {
            type: 'text',
            text: '[imagem enviada — não foi possível carregar pra eu visualizar]',
          } as Anthropic.TextBlockParam;
        },
      );
      return { ...message, content: parts } as Anthropic.MessageParam;
    });
    return found ? out : null;
  }

  private errorStatus(err: unknown): number | undefined {
    if (err instanceof Anthropic.APIError) return err.status;
    return (err as { status?: number })?.status;
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
