/**
 * Utilidades de CPF — detecção e validação.
 *
 * Usadas para (1) capturar automaticamente o CPF que o cliente digita na
 * conversa do WhatsApp e (2) casar o contato com o cliente no Tramitação
 * Inteligente pela chave exata (cpf_cnpj). Validamos os dígitos verificadores
 * para NÃO gravar um número qualquer de 11 dígitos (telefone, protocolo, etc.).
 */

/** Remove tudo que não é dígito. */
export function onlyDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * Valida um CPF pelos dígitos verificadores (algoritmo oficial da Receita).
 * Aceita string com ou sem formatação. Rejeita sequências repetidas
 * (000.., 111.., ...) que passam na conta mas nunca são CPFs reais.
 */
export function isValidCpf(value: string | null | undefined): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11) return false;
  // Todos os dígitos iguais (00000000000, 11111111111, ...) — inválidos.
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digits = cpf.split('').map((d) => parseInt(d, 10));
  for (let t = 9; t < 11; t++) {
    let sum = 0;
    for (let i = 0; i < t; i++) {
      sum += digits[i] * (t + 1 - i);
    }
    let check = (sum * 10) % 11;
    if (check === 10) check = 0;
    if (check !== digits[t]) return false;
  }
  return true;
}

/**
 * Procura no texto o PRIMEIRO CPF válido (formatado "000.000.000-00" ou 11
 * dígitos seguidos) e devolve só os dígitos. Retorna null se não achar nenhum
 * que passe na validação dos dígitos verificadores.
 *
 * A varredura considera candidatos formatados e também blocos de dígitos.
 * Para blocos longos (o cliente às vezes cola tudo junto: "cpf11122233344
 * rg..."), testamos cada janela de 11 dígitos — assim um CPF grudado em outro
 * número ainda é achado.
 */
export function extractCpf(text: string | null | undefined): string | null {
  if (!text) return null;

  // 1) Candidatos formatados: 000.000.000-00 (com pontuação flexível).
  const formatted = text.match(/\d{3}\D?\d{3}\D?\d{3}\D?\d{2}/g) ?? [];
  for (const cand of formatted) {
    const d = onlyDigits(cand);
    if (d.length === 11 && isValidCpf(d)) return d;
  }

  // 2) Blocos de dígitos: testa cada janela de 11 dígitos consecutivos.
  const blocks = text.match(/\d{11,}/g) ?? [];
  for (const block of blocks) {
    for (let i = 0; i + 11 <= block.length; i++) {
      const window = block.slice(i, i + 11);
      if (isValidCpf(window)) return window;
    }
  }

  return null;
}

/** Formata 11 dígitos como 000.000.000-00 (para exibição). */
export function formatCpf(value: string | null | undefined): string {
  const d = onlyDigits(value);
  if (d.length !== 11) return value ?? '';
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
