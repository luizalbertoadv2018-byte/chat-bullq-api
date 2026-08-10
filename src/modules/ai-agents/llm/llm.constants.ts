/**
 * Modelos OpenAI usados pelos agentes de IA.
 *
 * - SIMPLE: tarefas baratas/mecânicas (classificador de intenção, iterações
 *   de ferramenta, reranker, extração de memória). Rápido e barato.
 * - CONVERSATION: síntese da resposta final ao cliente, onde a qualidade
 *   pesa (agentes WORKER + resumo inteligente de conversa).
 *
 * IDs Claude/Sakana legados gravados no banco são remapeados p/ estes no
 * LlmService.normalizeModelId — trocar aqui muda o default de todo mundo.
 * Pra baratear ainda mais, dá pra apontar CONVERSATION p/ 'gpt-4o-mini'.
 */

/** Modelo barato para tarefas de fundo. */
export const LLM_SIMPLE_MODEL = 'gpt-4o-mini';

/**
 * Modelo da resposta final ao cliente. Rebaixado de 'gpt-4o' p/ 'gpt-4o-mini'
 * em 2026-08-07: o gpt-4o custava ~R$20 numa conversa longa (síntese de todo
 * WORKER escalava pro modelo caro a cada turno). Com mini, mesma conversa
 * ~R$1,25 (~16x mais barato). Pra recuperar qualidade sem voltar ao 4o, dá
 * pra apontar aqui p/ 'gpt-4.1-mini' (~6x vs 4o, melhor em tools/instrução).
 */
export const LLM_CONVERSATION_MODEL = 'gpt-5-mini';
// (restart trigger: migrado p/ OpenAI 2026-08-06; barateado 2026-08-07; conversation -> gpt-5-mini 2026-08-10)
