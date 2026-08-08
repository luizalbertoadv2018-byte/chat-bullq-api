import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Sincroniza tarefas com o Google Agenda do escritório (one-way: tarefa →
 * evento). Autocontido: fala direto com a API do Google via OAuth de usuário
 * (refresh_token), sem SDK e sem depender do GoogleAuthService dos agentes —
 * pra não acoplar nem arriscar o código existente.
 *
 * Fica DESLIGADO até estarem setadas as envs:
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
 *   TASKS_CALENDAR_ID (id do calendário; normalmente o e-mail da conta) — cai
 *     em SOFIA_CALENDAR_ID se não houver.
 * Sem isso, `isEnabled()` = false e a sincronização é silenciosamente pulada
 * (o botão manual "Adicionar ao Google Agenda" no front continua funcionando).
 */
export interface CalendarTaskInput {
  title: string;
  description?: string | null;
  category?: string | null;
  dueAt: Date | string | null;
  contactName?: string | null;
}

const TZ = 'America/Sao_Paulo';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

@Injectable()
export class TaskCalendarService {
  private readonly logger = new Logger(TaskCalendarService.name);
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly config: ConfigService) {}

  private get clientId() {
    return this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID');
  }
  private get clientSecret() {
    return this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET');
  }
  private get refreshToken() {
    return this.config.get<string>('GOOGLE_OAUTH_REFRESH_TOKEN');
  }
  private get calendarId() {
    return (
      this.config.get<string>('TASKS_CALENDAR_ID') ??
      this.config.get<string>('SOFIA_CALENDAR_ID')
    );
  }

  isEnabled(): boolean {
    return !!(
      this.clientId &&
      this.clientSecret &&
      this.refreshToken &&
      this.calendarId
    );
  }

  private async accessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.token;
    }
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId ?? '',
        client_secret: this.clientSecret ?? '',
        refresh_token: this.refreshToken ?? '',
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`google token ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };
    this.cached = {
      token: json.access_token,
      expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
    };
    return json.access_token;
  }

  private eventBody(task: CalendarTaskInput) {
    const start = new Date(task.dueAt as string | Date);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const description = [
      task.description ?? '',
      task.category ? `Categoria: ${task.category}` : '',
      task.contactName ? `Cliente: ${task.contactName}` : '',
      '(criado automaticamente pelo painel de Tarefas)',
    ]
      .filter(Boolean)
      .join('\n');
    return {
      summary: task.title,
      description,
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end: { dateTime: end.toISOString(), timeZone: TZ },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 24 * 60 },
        ],
      },
    };
  }

  /**
   * Cria ou atualiza o evento da tarefa. Retorna { eventId, htmlLink } ou null
   * (desligado, sem prazo, ou falha — nunca lança, pra não quebrar o CRUD).
   */
  async upsert(
    task: CalendarTaskInput,
    existingEventId?: string | null,
  ): Promise<{ eventId: string; htmlLink: string | null } | null> {
    if (!this.isEnabled() || !task.dueAt) return null;
    try {
      const token = await this.accessToken();
      const cal = encodeURIComponent(this.calendarId as string);
      const body = JSON.stringify(this.eventBody(task));
      const isUpdate = !!existingEventId;
      const url = isUpdate
        ? `${CAL_BASE}/${cal}/events/${existingEventId}`
        : `${CAL_BASE}/${cal}/events`;
      const res = await fetch(url, {
        method: isUpdate ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      // Evento sumiu (apagado à mão no Google) → recria do zero.
      if (res.status === 404 && isUpdate) {
        return this.upsert(task, null);
      }
      if (!res.ok) {
        throw new Error(`calendar ${res.status}: ${await res.text()}`);
      }
      const ev = (await res.json()) as { id: string; htmlLink?: string };
      return { eventId: ev.id, htmlLink: ev.htmlLink ?? null };
    } catch (err: any) {
      this.logger.warn(`sync de tarefa → agenda falhou: ${err?.message ?? err}`);
      return null;
    }
  }

  /** Remove o evento (silencioso se desligado/falha). */
  async remove(eventId: string): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      const token = await this.accessToken();
      const cal = encodeURIComponent(this.calendarId as string);
      await fetch(`${CAL_BASE}/${cal}/events/${eventId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err: any) {
      this.logger.warn(`remoção do evento da agenda falhou: ${err?.message ?? err}`);
    }
  }
}
