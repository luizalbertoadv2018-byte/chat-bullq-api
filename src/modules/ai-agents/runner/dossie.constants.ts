/**
 * Dossiê do caso: o que a equipe precisa saber do cliente para redigir a
 * peça, colhido depois da assinatura pelo agente de coleta. Fica em
 * `contact.metadata.dossie`, um valor de texto por campo.
 */
export interface DossieField {
  key: string;
  /** Como o campo aparece para o agente e nos avisos à equipe. */
  label: string;
  /** Campos obrigatórios definem se o dossiê está completo. */
  required: boolean;
}

export const DOSSIE_FIELDS: readonly DossieField[] = [
  { key: 'conta', label: 'identificador exato da conta (@, número ou e-mail)', required: true },
  { key: 'plataforma', label: 'plataforma ou instituição', required: false },
  { key: 'dataBloqueio', label: 'data aproximada do bloqueio', required: true },
  { key: 'desdeQuando', label: 'desde quando tem a conta', required: true },
  { key: 'uso', label: 'para que usava a conta', required: true },
  { key: 'revisao', label: 'pedido de revisão à plataforma e resposta', required: true },
  { key: 'prejuizo', label: 'prejuízo causado pelo bloqueio', required: true },
  { key: 'observacoes', label: 'observações', required: false },
];

export const DOSSIE_KEYS = DOSSIE_FIELDS.map((f) => f.key);

export function readDossie(contactMetadata: unknown): Record<string, string> {
  const raw = ((contactMetadata ?? {}) as Record<string, any>).dossie;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const key of DOSSIE_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  return out;
}

/** Campos obrigatórios ainda sem resposta, na ordem em que devem ser pedidos. */
export function missingDossieFields(contactMetadata: unknown): DossieField[] {
  const got = readDossie(contactMetadata);
  return DOSSIE_FIELDS.filter((f) => f.required && !got[f.key]);
}
