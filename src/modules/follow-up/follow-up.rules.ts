import type { BusinessHours } from './business-hours.util';

/**
 * Regras puras do follow-up: em que etapa cabe, quando parar e o que dizer à
 * IA. Sem banco aqui, pra dar pra testar.
 */

export const FOLLOW_UP_QUEUE = 'follow-up-timers';
export const FOLLOW_UP_JOB = 'follow-up';
export const FOLLOW_UP_SUMMARY_JOB = 'daily-summary';
/** Põe na fila leads que já estavam parados antes de o follow-up existir. */
export const FOLLOW_UP_BACKFILL_JOB = 'backfill';
/** Nome da coluna do kanban que recebe quem esgotou as tentativas. */
export const NO_RETURN_STAGE = 'Sem Retorno';

export const AUDIT_FOLLOW_UP_SENT = 'FOLLOW_UP_SENT';
export const AUDIT_FOLLOW_UP_EXHAUSTED = 'FOLLOW_UP_EXHAUSTED';

export interface FollowUpJobData {
  conversationId: string;
}

export interface FollowUpBackfillData {
  organizationId: string;
  /** Quantas conversas entram nesta leva. */
  limit?: number;
  /** Liga o follow-up só nas conversas da leva, mesmo com a org desligada. */
  force?: boolean;
  /** Minutos entre um envio e o seguinte dentro da leva. */
  spacingMinutes?: number;
}

/** Estado por conversa, em `conversations.metadata.followUp`. */
export interface FollowUpState {
  /** Tentativas já enviadas neste período de silêncio. */
  attempts?: number;
  nextAt?: string | null;
  /** Job agendado na fila; um job com outro id é velho e é ignorado. */
  jobId?: string | null;
  lastSentAt?: string | null;
  /** Etapa de onde o card saiu ao ir para "Sem Retorno". */
  previousStageId?: string | null;
  stopReason?: string | null;
  /** Pausado à mão no painel. */
  paused?: boolean;
  /** Liga o follow-up nesta conversa mesmo com a org desligada (teste). */
  force?: boolean;
  /** Cadência em minutos só desta conversa (teste). */
  cadenceMinutes?: number[];
  exhaustAfterMinutes?: number;
}

/** Em `organizations.settings.followUp`. */
export interface FollowUpSettings {
  enabled?: boolean;
  /** Só registra o que enviaria, sem enviar. */
  dryRun?: boolean;
  /** Agentes que fazem follow-up e a cadência de cada um, em horas de silêncio. */
  agents?: Record<string, { cadenceHours?: number[] }>;
  /** Teto de follow-ups enviados em 24h (proteção do número). */
  dailyCap?: number;
  /** Horas após a última tentativa até ir para "Sem Retorno". */
  exhaustAfterHours?: number;
  /**
   * Quando a IA pode mandar follow-up. Próprio do follow-up (não é o horário
   * geral de atendimento): retomar um lead é iniciativa nossa, então só em
   * dia útil e hora comercial. Padrão: seg a sex, 08:00 às 19:00.
   */
  businessHours?: BusinessHours;
  /**
   * Resumo diário no grupo de avisos. `true` liga mesmo com o follow-up
   * desligado; sem valor, acompanha `enabled`.
   */
  summary?: boolean;
}

export interface ResolvedFollowUpConfig {
  enabled: boolean;
  dryRun: boolean;
  /** Silêncio acumulado, em minutos, que dispara cada tentativa. */
  cadenceMinutes: number[];
  exhaustAfterMinutes: number;
  dailyCap: number;
  businessHours: BusinessHours;
  /** Cadência de teste: sem sorteio de atraso. */
  testMode: boolean;
}

const DEFAULT_CADENCE_HOURS = [24, 96];

const WORKDAY = { enabled: true, windows: [['08:00', '19:00']] as Array<[string, string]> };
/** Seg a sex, 08:00 às 19:00. Sábado e domingo fora. */
export const DEFAULT_FOLLOW_UP_HOURS: NonNullable<BusinessHours> = {
  monday: WORKDAY,
  tuesday: WORKDAY,
  wednesday: WORKDAY,
  thursday: WORKDAY,
  friday: WORKDAY,
  saturday: { enabled: false },
  sunday: { enabled: false },
};

export function resolveFollowUpConfig(
  settings: FollowUpSettings | undefined,
  agentId: string | null,
  state: FollowUpState,
): ResolvedFollowUpConfig {
  const agentCfg = agentId ? settings?.agents?.[agentId] : undefined;
  const testCadence = (state.cadenceMinutes ?? []).filter((n) => n > 0);
  const hours = (agentCfg?.cadenceHours ?? DEFAULT_CADENCE_HOURS).filter(
    (n) => Number.isFinite(n) && n > 0,
  );
  return {
    enabled: state.force === true || (settings?.enabled === true && !!agentCfg),
    dryRun: settings?.dryRun === true && state.force !== true,
    cadenceMinutes:
      testCadence.length > 0
        ? testCadence
        : (hours.length > 0 ? hours : DEFAULT_CADENCE_HOURS).map((h) => h * 60),
    exhaustAfterMinutes:
      state.exhaustAfterMinutes && state.exhaustAfterMinutes > 0
        ? state.exhaustAfterMinutes
        : (settings?.exhaustAfterHours ?? 72) * 60,
    dailyCap: settings?.dailyCap ?? 30,
    businessHours: settings?.businessHours ?? DEFAULT_FOLLOW_UP_HOURS,
    testMode: testCadence.length > 0,
  };
}

/**
 * Minutos a esperar, a partir de agora, até o próximo passo. A cadência é em
 * silêncio ACUMULADO ([24h, 96h] = 1 dia e 4 dias), então do 2º passo em
 * diante espera só a diferença. Passada a última tentativa, é o prazo até
 * "Sem Retorno".
 */
export function delayForStep(attempts: number, cfg: ResolvedFollowUpConfig): number {
  const c = cfg.cadenceMinutes;
  if (attempts >= c.length) return cfg.exhaustAfterMinutes;
  if (attempts <= 0) return c[0];
  return Math.max(c[attempts] - c[attempts - 1], 1);
}

export type StageKind = 'pre-sign' | 'post-sign' | 'none';

export function normalizeStage(value: string): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Em ordem de prioridade: quem está mais perto de assinar vem primeiro.
export const PRE_SIGN_STAGES = [
  'ficha enviada',
  'qualificado',
  'proposta enviada',
  'em analise',
  'analise',
  'lead novo',
];
const PRE_SIGN = new Set(PRE_SIGN_STAGES);
const POST_SIGN = new Set(['contrato assinado', 'aguardando documentos']);

/** Em que momento do funil a etapa está, pra efeito de follow-up. */
export function classifyStage(stageName: string | null | undefined): StageKind {
  const n = normalizeStage(stageName ?? '');
  if (PRE_SIGN.has(n)) return 'pre-sign';
  if (POST_SIGN.has(n)) return 'post-sign';
  return 'none';
}

// Documentos que a IA cobra depois da assinatura (os demais ficam com a equipe).
const BASIC_DOC = /\b(rg|cnh|comprovante de residencia|print)/;

export function isBasicDocument(name: string): boolean {
  return BASIC_DOC.test(normalizeStage(name));
}

const OPT_OUT =
  /\b(nao tenho (mais )?interesse|sem interesse|nao quero( mais)?|nao preciso( mais)?|ja resolvi|ja consegui|ja recuperei|pare de|para de|nao (me )?mande mais|nao (me )?chame mais|me tira|desisti|vou desistir|deixa (pra la|quieto))\b/;

/** O lead pediu pra parar ou disse que não quer mais? Então não insistimos. */
export function isOptOut(text: string | null | undefined): boolean {
  return OPT_OUT.test(normalizeStage(text ?? ''));
}

export function humanizeSilence(minutes: number): string {
  if (minutes < 90) return `${Math.max(Math.round(minutes), 1)} minutos`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)} horas`;
  return `${Math.round(hours / 24)} dias`;
}

const FOCUS: Record<string, string> = {
  'lead novo': 'retome a triagem de onde ela parou, repetindo de forma curta a última pergunta que ficou sem resposta',
  'em analise': 'retome a triagem de onde ela parou, repetindo de forma curta a última pergunta que ficou sem resposta',
  analise: 'retome a triagem de onde ela parou, repetindo de forma curta a última pergunta que ficou sem resposta',
  'proposta enviada': 'pergunte se ficou alguma dúvida sobre a proposta que você já enviou e se pode seguir',
  qualificado: 'lembre que falta só preencher a ficha e ofereça enviá-la agora',
  'ficha enviada': 'pergunte se ele conseguiu abrir o link da ficha e ofereça ajuda para assinar',
};

/**
 * Instrução que vai para a IA no lugar de uma mensagem do cliente. Diz que é
 * uma retomada, há quanto tempo o lead está em silêncio e o que escrever.
 */
export function buildFollowUpNote(input: {
  stageName: string;
  kind: StageKind;
  silenceMinutes: number;
  attempt: number;
  maxAttempts: number;
  missingDocs?: string[];
}): string {
  const last = input.attempt >= input.maxAttempts;
  const focus =
    input.kind === 'post-sign'
      ? `o cliente já assinou; cobre com gentileza apenas o que ainda falta enviar: ${(input.missingDocs ?? []).join(', ')}`
      : (FOCUS[normalizeStage(input.stageName)] ?? 'retome a conversa de onde ela parou');

  return [
    `FOLLOW-UP: o contato está sem responder há ${humanizeSilence(input.silenceMinutes)}.`,
    `Etapa atual no funil: ${input.stageName}. Esta é a retomada ${input.attempt} de ${input.maxAttempts}.`,
    `Escreva UMA única mensagem curta (no máximo 2 linhas) para retomar: ${focus}.`,
    'Não repita pergunta que ele já respondeu, não recomece a triagem, não reenvie a proposta inteira e não gere outra ficha.',
    'Não diga que é mensagem automática, não diga que ele sumiu e não cobre em tom de bronca.',
    last && input.kind === 'pre-sign'
      ? 'É a última retomada: diga com gentileza que vai encerrar o atendimento por aqui para não incomodar e que, se ele quiser retomar, é só responder a qualquer momento.'
      : '',
    'Envie com replyToConversation e não use nenhuma outra ferramenta nesta rodada.',
  ]
    .filter(Boolean)
    .join(' ');
}
