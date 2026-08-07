import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmContent,
  LlmMessage,
  LlmTextPart,
  LlmToolCall,
  LlmToolDefinition,
  LlmUsage,
} from './llm.types';
import { LLM_CONVERSATION_MODEL, LLM_SIMPLE_MODEL } from './llm.constants';

/**
 * Preço por 1M tokens (USD) — APROXIMADO, só p/ registrar custo interno
 * (não é cobrança). Confira em https://openai.com/pricing se precisar de
 * exatidão. `cached` = input servido de cache (desconto automático da OpenAI).
 */
const PRICING: Record<string, { in: number; out: number; cached: number }> = {
  'gpt-4o': { in: 2.5, out: 10, cached: 1.25 },
  'gpt-4o-mini': { in: 0.15, out: 0.6, cached: 0.075 },
  'gpt-4.1': { in: 2, out: 8, cached: 0.5 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6, cached: 0.1 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4, cached: 0.025 },
};

// ─── Formato da OpenAI Chat Completions ────────────────────────────────
interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAiContentPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}
interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
interface OpenAiChoiceMessage {
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
}
interface OpenAiResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: OpenAiChoiceMessage;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Cliente LLM normalizado — fala com a API da OpenAI (Chat Completions).
 *
 * Mantém o contrato público usado pelo runner, classifier, memória, RAG e
 * evals (`complete()`, `LlmMessage`, `LlmToolDefinition`). Converte nossos
 * tipos ↔ Chat Completions. IDs legados (Claude/Sakana) gravados no banco
 * são mapeados p/ modelos OpenAI em vez de quebrar agentes antigos.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly apiKey: string;
  private readonly hasApiKey: boolean;
  private readonly timeoutMs: number;
  private readonly endpoint = 'https://api.openai.com/v1/chat/completions';

  constructor(config: ConfigService) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ?? process.env.OPENAI_API_KEY ?? '';
    const timeout = Number(config.get<string>('OPENAI_TIMEOUT_MS') ?? 120_000);

    this.hasApiKey = !!apiKey;
    this.apiKey = apiKey;
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000;

    if (!apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY not set — AI agents will fail at runtime',
      );
    }
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (!this.hasApiKey) {
      throw new InternalServerErrorException('OPENAI_API_KEY not set');
    }

    const model = this.normalizeModelId(req.modelId);
    const messages = this.toOpenAi(req.messages);
    // Precisa de pelo menos uma mensagem que não seja só system.
    if (!messages.some((m) => m.role !== 'system')) {
      throw new BadRequestException('LLM request has no user/assistant messages');
    }
    const tools = req.tools
      ? this.toOpenAiTools(this.sanitizeTools(req.tools))
      : undefined;

    const body: Record<string, unknown> = {
      model,
      messages,
      max_completion_tokens: req.maxTokens ?? 2048,
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      ...(this.acceptsSampling(model)
        ? { temperature: req.temperature ?? 0.7 }
        : {}),
      // Melhora o roteamento do prompt caching automático da OpenAI entre
      // turnos da mesma conversa (prefixo system + histórico idênticos).
      ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
      ...(this.sanitizeModelParams(req.modelParams) as object),
    };

    let data: OpenAiResponse;
    try {
      data = await this.post(body);
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
          data = await this.post({ ...body, messages: stripped });
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

    const choice = data.choices?.[0];
    const message = this.fromOpenAi(choice?.message);
    const stopReason = this.normalizeStopReason(choice?.finish_reason);
    const usage = this.extractUsage(data.usage, model);

    return {
      message,
      stopReason,
      usage,
      rawModelId: data.model ?? model,
    };
  }

  // ─── HTTP ─────────────────────────────────────────────────────────

  private async post(body: Record<string, unknown>): Promise<OpenAiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(
          `OpenAI ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as OpenAiResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── conversão: nossos tipos → OpenAI ─────────────────────────────

  /**
   * Aceita IDs OpenAI (`gpt-*`, `o1/o3/o4-*`, `chatgpt-*`). IDs Claude/Sakana
   * legados gravados no banco são mapeados p/ equivalentes OpenAI:
   *   - "haiku"/simples → gpt-4o-mini (barato)
   *   - opus/sonnet/fable/conversa → gpt-4o (qualidade)
   */
  private normalizeModelId(id: string): string {
    const raw = (id ?? '').trim();
    if (!raw) throw new BadRequestException('modelId is required');
    const t = raw.startsWith('openai/') ? raw.slice('openai/'.length) : raw;

    if (/^(gpt-|o\d|chatgpt)/i.test(t)) return t;

    // Claude → OpenAI
    if (/claude/i.test(t) || /haiku/i.test(t)) {
      return /haiku/i.test(t) ? LLM_SIMPLE_MODEL : LLM_CONVERSATION_MODEL;
    }
    // Legado Sakana → OpenAI
    if (/ultra/i.test(t)) return LLM_CONVERSATION_MODEL;
    if (/fugu/i.test(t) || /^sakana/i.test(t)) return LLM_SIMPLE_MODEL;

    this.logger.warn(
      `modelId desconhecido "${raw}" — usando ${LLM_CONVERSATION_MODEL}`,
    );
    return LLM_CONVERSATION_MODEL;
  }

  /** Modelos de raciocínio (o-series, gpt-5) rejeitam temperature != 1. */
  private acceptsSampling(model: string): boolean {
    return !(/^o\d/i.test(model) || /^gpt-5/i.test(model));
  }

  /**
   * Converte `LlmMessage[]` para o formato de mensagens da OpenAI:
   *  - system vira UMA mensagem `system` com o texto concatenado. (O prompt
   *    caching da OpenAI é automático p/ prefixos > 1024 tokens — não precisa
   *    de marcador de cache.)
   *  - tool results (role 'tool') viram mensagens `tool` individuais com
   *    `tool_call_id`.
   */
  private toOpenAi(input: LlmMessage[]): OpenAiMessage[] {
    const systemParts: string[] = [];
    const out: OpenAiMessage[] = [];

    for (const m of input) {
      if (m.role === 'system') {
        const text = this.textOnly(m.content);
        if (text) systemParts.push(text);
        continue;
      }

      if (m.role === 'user') {
        const content = this.userContent(m.content);
        if (this.isEmptyContent(content)) continue;
        out.push({ role: 'user', content });
        continue;
      }

      if (m.role === 'assistant') {
        const text = this.textOnly(m.content);
        const toolCalls = (m.toolCalls ?? []).map<OpenAiToolCall>((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        }));
        if (!text && toolCalls.length === 0) continue;
        out.push({
          role: 'assistant',
          content: text ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        continue;
      }

      if (m.role === 'tool') {
        if (!m.toolCallId) {
          this.logger.warn('Tool message without toolCallId — dropping');
          continue;
        }
        out.push({
          role: 'tool',
          tool_call_id: m.toolCallId,
          content: this.textOnly(m.content) || '(empty)',
          ...(m.name ? { name: m.name } : {}),
        });
      }
    }

    if (systemParts.length > 0) {
      out.unshift({ role: 'system', content: systemParts.join('\n\n') });
    }
    return out;
  }

  private userContent(content: LlmContent): string | OpenAiContentPart[] {
    if (typeof content === 'string') return content;

    const parts: OpenAiContentPart[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        if (part.text && part.text.length > 0) {
          parts.push({ type: 'text', text: part.text });
        }
        continue;
      }
      if (part.type === 'image') {
        const url = this.imageUrl(part);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (parts.length === 0) return '';
    return parts;
  }

  /** OpenAI recebe imagem via `image_url` — URL pública ou data-URI base64. */
  private imageUrl(part: { url?: string; base64?: { mediaType: string; data: string } }): string | null {
    if (part.url) return part.url;
    if (part.base64) {
      return `data:${part.base64.mediaType};base64,${part.base64.data}`;
    }
    return null;
  }

  private isEmptyContent(content: unknown): boolean {
    if (typeof content === 'string') return content.length === 0;
    if (Array.isArray(content)) return content.length === 0;
    return content == null;
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

  private toOpenAiTools(tools: LlmToolDefinition[]): OpenAiTool[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Passa só overrides compatíveis com a Chat Completions. Campos antigos
   * (Anthropic-style / thinking custom) são ignorados sem quebrar runs.
   */
  private sanitizeModelParams(
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!params) return {};
    const allowed = new Set([
      'top_p',
      'stop',
      'presence_penalty',
      'frequency_penalty',
      'seed',
      'response_format',
      'metadata',
    ]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (allowed.has(k)) out[k] = v;
    }
    return out;
  }

  // ─── conversão: OpenAI → nossos tipos ─────────────────────────────

  private fromOpenAi(message: OpenAiChoiceMessage | undefined): LlmMessage {
    const toolCalls: LlmToolCall[] = [];
    const text = message?.content ?? '';

    for (const tc of message?.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(tc.function.arguments || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        this.logger.warn(
          `Tool args inválidos p/ ${tc.function.name}: ${tc.function.arguments?.slice(0, 200)}`,
        );
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
    }

    return {
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private normalizeStopReason(
    reason: string | undefined,
  ): LlmCompletionResponse['stopReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'other';
    }
  }

  private extractUsage(
    usage: OpenAiResponse['usage'],
    model: string,
  ): LlmUsage {
    const prompt = usage?.prompt_tokens ?? 0;
    const output = usage?.completion_tokens ?? 0;
    // Na OpenAI, `prompt_tokens` INCLUI os cacheados; separamos p/ manter a
    // semântica do nosso LlmUsage (inputTokens = input NÃO-cacheado).
    const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const input = Math.max(0, prompt - cacheRead);
    const costUsd = this.calculateCost(model, { input, output, cacheRead });

    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      // OpenAI não cobra "cache write" à parte (cache é desconto automático).
      cacheWriteTokens: 0,
      costUsd,
    };
  }

  private calculateCost(
    model: string,
    tokens: { input: number; output: number; cacheRead: number },
  ): number {
    const p = PRICING[model];
    if (!p) return 0;
    return (
      (tokens.input * p.in +
        tokens.output * p.out +
        tokens.cacheRead * p.cached) /
      1_000_000
    );
  }

  // ─── error handling ──────────────────────────────────────────────

  private logError(
    err: unknown,
    model: string,
    tools: OpenAiTool[] | undefined,
  ): void {
    const status = this.errorStatus(err);
    const message = this.errorMessage(err);
    const toolNames = tools?.map((t) => t.function.name).join(',');
    this.logger.error(
      `LLM call failed [${model}] status=${status ?? '?'}: ${message} | tools=[${toolNames ?? ''}]`,
    );
  }

  /** Troca cada bloco de imagem por marcador textual; null se não havia. */
  private stripImageParts(messages: OpenAiMessage[]): OpenAiMessage[] | null {
    let found = false;
    const out = messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      const parts = message.content.map<OpenAiContentPart>((part) => {
        if (part?.type !== 'image_url') return part;
        found = true;
        return {
          type: 'text',
          text: '[imagem enviada — não foi possível carregar pra eu visualizar]',
        };
      });
      return { ...message, content: parts };
    });
    return found ? out : null;
  }

  private errorStatus(err: unknown): number | undefined {
    return (err as { status?: number })?.status;
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
