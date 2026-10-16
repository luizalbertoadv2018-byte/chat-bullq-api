/**
 * Link de assinatura recém-gerado, à espera da próxima resposta do agente.
 *
 * O agente respondia "enviei o link da ficha" sem colar o link (lia que o
 * cliente "já recebeu por e-mail/WhatsApp"). Agora enviarDocumentoAssinatura
 * registra o link aqui e replyToConversation garante que ele vá na resposta.
 *
 * Em memória e por conversa: a API roda num contêiner só. Expira em 15 min
 * para não colar um link velho numa conversa que seguiu outro rumo.
 */
const TTL_MS = 15 * 60_000;

const pending = new Map<string, { link: string; at: number }>();

export function rememberSigningLink(conversationId: string, link: string): void {
  pending.set(conversationId, { link, at: Date.now() });
}

/**
 * Devolve o texto com o link garantido (se havia um pendente e o texto ainda
 * não o contém) e consome o pendente.
 */
export function withPendingSigningLink(
  conversationId: string,
  text: string,
): string {
  const entry = pending.get(conversationId);
  if (!entry) return text;
  pending.delete(conversationId);
  if (Date.now() - entry.at > TTL_MS) return text;
  if (text.includes(entry.link)) return text;
  return `${text}\n\n${entry.link}`;
}
