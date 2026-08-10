import { Injectable } from '@nestjs/common';
import type { Organization } from '@prisma/client';
import {
  DEFAULT_WATCHDOG_CONFIG,
  WatchdogConfig,
} from './watchdog.types';

interface BusinessHoursDay {
  enabled: boolean;
  windows?: Array<[string, string]>;
}
type BusinessHoursConfig = Record<string, BusinessHoursDay>;

const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/**
 * Resolve a config efetiva do watchdog (merge defaults + override do banco)
 * e expõe `isWithinBusinessHours()` espelhando o helper do `AgentRouter`.
 *
 * Reusamos `org.aiTimezone` em vez de duplicar — a expectativa é que a org
 * use o mesmo fuso pra IA e pro watchdog. Se for preciso desacoplar, basta
 * adicionar `watchdogTimezone` na Organization e aqui.
 */
@Injectable()
export class WatchdogConfigService {
  resolve(org: Pick<Organization, 'watchdogConfig'>): Required<WatchdogConfig> {
    const override = (org.watchdogConfig as WatchdogConfig | null) ?? {};
    return {
      delayBotMin: override.delayBotMin ?? DEFAULT_WATCHDOG_CONFIG.delayBotMin,
      delayPendingMin:
        override.delayPendingMin ?? DEFAULT_WATCHDOG_CONFIG.delayPendingMin,
      delayHumanIdleMin:
        override.delayHumanIdleMin ?? DEFAULT_WATCHDOG_CONFIG.delayHumanIdleMin,
      maxAttempts:
        override.maxAttempts ?? DEFAULT_WATCHDOG_CONFIG.maxAttempts,
      attemptDelaysMin:
        Array.isArray(override.attemptDelaysMin) &&
        override.attemptDelaysMin.length > 0
          ? override.attemptDelaysMin.filter((n) => Number.isFinite(n) && n > 0)
          : DEFAULT_WATCHDOG_CONFIG.attemptDelaysMin,
    };
  }

  isWithinBusinessHours(
    org: Pick<Organization, 'watchdogBusinessHours' | 'aiTimezone'>,
  ): boolean {
    if (!org.watchdogBusinessHours) return true; // 24/7 default

    const config = org.watchdogBusinessHours as unknown as BusinessHoursConfig;
    const tz = org.aiTimezone || 'America/Sao_Paulo';

    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const weekday =
      parts.find((p) => p.type === 'weekday')?.value.toLowerCase() ?? '';
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const nowMinutes = parseInt(hour, 10) * 60 + parseInt(minute, 10);

    if (!DAY_KEYS.includes(weekday as (typeof DAY_KEYS)[number])) {
      return true;
    }
    const day = config[weekday];
    if (!day || !day.enabled) return false;

    const windows = day.windows ?? [];
    if (windows.length === 0) return true;

    return windows.some(([from, to]) => {
      const fromMin = this.parseHourToMinutes(from);
      const toMin = this.parseHourToMinutes(to);
      return nowMinutes >= fromMin && nowMinutes < toMin;
    });
  }

  private parseHourToMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
    return (h || 0) * 60 + (m || 0);
  }
}
