/**
 * Modelos Claude (Anthropic) usados pelos agentes de IA.
 *
 * - SIMPLE: tarefas baratas/mecânicas (classificador de intenção, iterações
 *   de ferramenta, reranker, extração de memória). Rápido e barato.
 * - CONVERSATION: síntese da resposta final ao cliente, onde a qualidade
 *   pesa (agentes WORKER + resumo inteligente de conversa).
 *
 * Pra reduzir custo em alto volume, dá pra trocar CONVERSATION por
 * 'claude-sonnet-4-6' (aceita temperature) sem mexer no resto.
 */

/** Modelo barato para tarefas de fundo. */
export const LLM_SIMPLE_MODEL = 'claude-haiku-4-5';

/** Modelo forte para a resposta final ao cliente. */
export const LLM_CONVERSATION_MODEL = 'claude-opus-4-8';
// (restart trigger: ANTHROPIC_API_KEY carregada 2026-08-02)
