import { Injectable, Logger } from '@nestjs/common';

import {
  LLM_CONVERSATION_MODEL,
  LLM_SIMPLE_MODEL,
} from '../llm/llm.constants';

/**
 * Fase da chamada LLM dentro de um turno do agente.
 *  - `tool`      → iteração que (provavelmente) vai pedir/encadear ferramentas.
 *                  É mecânico: sempre roda no modelo barato (fugu).
 *  - `synthesis` → a resposta final ao cliente. Aqui é onde a qualidade pesa,
 *                  então workers escalam pro fugu-ultra; o orquestrador (triagem)
 *                  fica no fugu.
 */
export type LlmPhase = 'tool' | 'synthesis';

export type AgentKind = 'ORCHESTRATOR' | 'WORKER';

/**
 * Override opcional por agente, gravado em `AiAgent.modelParams.routing`
 * (coluna JSON já existente — sem migration). Ex.:
 *   { "routing": { "primary": "sakana/fugu",
 *                  "escalation": "sakana/fugu-ultra-20260615",
 *                  "alwaysPrimary": false,
 *                  "escalateSynthesis": true } }
 */
interface RoutingOverride {
  primary?: string;
  escalation?: string;
  /** Trava o agente inteiro no modelo barato (nunca escala). */
  alwaysPrimary?: boolean;
  /** Força/inibe escalonamento da síntese independente do kind. */
  escalateSynthesis?: boolean;
}

export interface SelectModelInput {
  agentKind: AgentKind;
  /** `AiAgent.modelId` — usado como modelo de escalonamento default. */
  modelId: string;
  /** `AiAgent.modelParams` cru do banco. */
  modelParams?: Record<string, unknown> | null;
  phase: LlmPhase;
}

/**
 * Decide qual modelo Sakana usar em cada chamada do loop do agente.
 *
 * Estratégia (objetivo: usar mais o fugu, ultra só quando necessário):
 *  - Toda iteração de ferramenta roda no `fugu` (barato, baixa latência).
 *  - A síntese final:
 *      • WORKER (especialista de vendas/suporte/impl) → escala pro `fugu-ultra`
 *        (é a resposta que o cliente lê; qualidade importa).
 *      • ORCHESTRATOR (Augusto, triagem/small-talk/ambíguo) → fica no `fugu`.
 *  - Qualquer agente pode sobrescrever via `modelParams.routing`.
 */
@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);

  selectModel(input: SelectModelInput): string {
    const routing = this.parseRouting(input.modelParams);

    // Sanitiza pra GARANTIR um ID Claude válido. Agentes legados podem ter
    // `modelId` antigo do Sakana ("sakana/fugu-ultra-20260615") — mapeamos
    // pro Claude equivalente em vez de quebrar no provider. Mesma proteção
    // pra overrides mal preenchidos.
    const primary = this.toClaude(routing.primary, LLM_SIMPLE_MODEL);
    const escalation = this.toClaude(
      routing.escalation ?? input.modelId,
      LLM_CONVERSATION_MODEL,
    );

    if (routing.alwaysPrimary) return primary;

    // Iterações de ferramenta são sempre baratas.
    if (input.phase === 'tool') return primary;

    // Síntese final: decide se escala.
    const escalate =
      routing.escalateSynthesis ?? input.agentKind === 'WORKER';

    return escalate ? escalation : primary;
  }

  /**
   * Garante um ID Claude válido. IDs `claude-*` passam direto; IDs legados do
   * Sakana são mapeados (`*ultra*` → conversa, `*fugu*`/`sakana*` → simples);
   * qualquer outra coisa (override quebrado, vazio) cai no fallback informado.
   */
  private toClaude(model: string | undefined | null, fallback: string): string {
    const m = (model ?? '').trim();
    if (m.startsWith('claude-')) return m;
    if (m.includes('ultra')) return LLM_CONVERSATION_MODEL;
    if (m.includes('fugu') || m.startsWith('sakana')) return LLM_SIMPLE_MODEL;
    return fallback;
  }

  private parseRouting(
    modelParams: Record<string, unknown> | null | undefined,
  ): RoutingOverride {
    const raw = modelParams?.routing;
    if (!raw || typeof raw !== 'object') return {};
    const r = raw as Record<string, unknown>;
    return {
      primary: typeof r.primary === 'string' ? r.primary : undefined,
      escalation: typeof r.escalation === 'string' ? r.escalation : undefined,
      alwaysPrimary: r.alwaysPrimary === true,
      escalateSynthesis:
        typeof r.escalateSynthesis === 'boolean'
          ? r.escalateSynthesis
          : undefined,
    };
  }
}
