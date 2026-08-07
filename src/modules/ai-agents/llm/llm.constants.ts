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

/** Modelo forte para a resposta final ao cliente. */
export const LLM_CONVERSATION_MODEL = 'gpt-4o';
// (restart trigger: migrado p/ OpenAI 2026-08-06)
