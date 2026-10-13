/**
 * Horário comercial no formato já usado em `organizations.watchdogBusinessHours`:
 * `{ monday: { enabled, windows: [["08:00","20:00"]] }, ... }`. `null` = 24/7;
 * dia habilitado sem janelas = o dia todo.
 */
export interface BusinessHoursDay {
  enabled: boolean;
  windows?: Array<[string, string]>;
}
export type BusinessHours = Record<string, BusinessHoursDay> | null | undefined;

const STEP_MS = 5 * 60 * 1000;
const MAX_STEPS = (8 * 24 * 60) / 5; // 8 dias

function toMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map((v) => parseInt(v, 10));
  return (h || 0) * 60 + (m || 0);
}

function localParts(date: Date, timeZone: string): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // "24" aparece à meia-noite em alguns ambientes.
  const hour = parseInt(get('hour'), 10) % 24;
  return {
    weekday: get('weekday').toLowerCase(),
    minutes: hour * 60 + parseInt(get('minute'), 10),
  };
}

export function isWithinBusinessHours(
  config: BusinessHours,
  timeZone: string,
  date: Date,
): boolean {
  if (!config) return true;
  const { weekday, minutes } = localParts(date, timeZone);
  const day = config[weekday];
  if (!day || !day.enabled) return false;
  const windows = day.windows ?? [];
  if (windows.length === 0) return true;
  return windows.some(
    ([from, to]) => minutes >= toMinutes(from) && minutes < toMinutes(to),
  );
}

/**
 * Primeiro instante, a partir de `from`, dentro do horário comercial. Devolve
 * o próprio `from` se ele já estiver dentro. Anda de 5 em 5 minutos (por isso
 * não depende de conta de fuso) e desiste em 8 dias, devolvendo `from`.
 */
export function nextBusinessInstant(
  config: BusinessHours,
  timeZone: string,
  from: Date,
): Date {
  if (isWithinBusinessHours(config, timeZone, from)) return from;
  // Alinha no múltiplo de 5 min seguinte pra cair exatamente na abertura.
  let t = Math.ceil(from.getTime() / STEP_MS) * STEP_MS;
  for (let i = 0; i < MAX_STEPS; i++, t += STEP_MS) {
    const candidate = new Date(t);
    if (isWithinBusinessHours(config, timeZone, candidate)) return candidate;
  }
  return from;
}
