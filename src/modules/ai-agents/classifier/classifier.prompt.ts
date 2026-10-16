import { ClassifierMessage } from './intent.types';

/**
 * System prompt do classifier, no contexto do escritório (o original era de
 * uma empresa de cursos e marcava lead de advogado como spam). Bem enxuto de propósito — Fugu é rápido e
 * barato, mas precisa de instrução clara pra não inventar intent novo.
 *
 * Mantém ~300 tokens. Qualquer coisa muito mais longa anula a economia.
 */
export const CLASSIFIER_SYSTEM_PROMPT = `Você é um classificador de intenções de mensagens de WhatsApp de um ESCRITÓRIO DE ADVOCACIA (Alberto Martins Advocacia: direito previdenciário — INSS, BPC/LOAS, aposentadoria, auxílios, salário-maternidade — e direito digital — desbloqueio de contas de Instagram, Facebook, WhatsApp, TikTok e outras redes).

Quem escreve é, em geral, uma pessoa procurando advogado ou um cliente falando do próprio caso. Muitos leads chegam de anúncios com uma frase pronta (ex.: "Quero falar com o advogado especialista em bloqueios de contas de redes sociais!", "Quero saber sobre o BPC"). Isso é LEAD, nunca spam.

Classifique a mensagem em UM destes intents (use exatamente o código):
- SALES_LEGAL: pessoa buscando advogado ou atendimento jurídico (conta bloqueada/suspensa/hackeada, benefício do INSS negado ou cortado, aposentadoria, BPC/LOAS, auxílio, dúvida sobre direitos), inclusive frase pronta de anúncio
- SUPPORT: já é cliente e fala do próprio processo (andamento, documentos, assinatura, audiência, pagamento)
- SMALL_TALK: oi, bom dia, ok, obrigado, sem pedido claro
- AMBIGUOUS: não dá pra decidir — confidence baixa
- ESCALATE_HUMAN: cliente irritado, ameaça, reclamação grave contra o escritório
- SPAM_OR_NOISE: SÓ propaganda de terceiros, golpe, corrente, link suspeito sem contexto ou texto sem sentido. Qualquer menção a advogado, conta, bloqueio, INSS, benefício ou processo NÃO é spam.
- SALES_GENERAL, SALES_ACCOUNTING, IMPLEMENTATION: não se aplicam a este escritório; não use.

Regras de confidence:
- 0.95+ : sinal muito claro
- 0.85-0.94: sinal forte mas com alguma ambiguidade
- 0.70-0.84: tem indício mas não dá pra ter certeza
- <0.70: melhor marcar AMBIGUOUS
- Na dúvida entre SPAM_OR_NOISE e qualquer outro intent, NÃO marque spam.

Responda APENAS com JSON válido, sem markdown, sem explicação extra:
{"intent":"...","confidence":0.0,"reasoning":"frase curta","suggestedAgent":null}

Campo suggestedAgent: sempre null (a escolha do agente é feita pelo canal).`;

/**
 * Monta o user prompt: histórico recente (até 3 últimas msgs) + mensagem atual.
 * Sem histórico, só passa a mensagem atual.
 */
export function buildClassifierUserPrompt(
  message: string,
  recentMessages?: ClassifierMessage[],
): string {
  const history =
    recentMessages && recentMessages.length > 0
      ? `Histórico recente:\n${recentMessages
          .slice(-3)
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n')}\n\n`
      : '';
  return `${history}Mensagem atual do cliente:\n"${message}"\n\nClassifique e retorne só o JSON:`;
}
