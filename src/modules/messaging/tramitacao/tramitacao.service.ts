import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Cliente da API do Tramitação Inteligente + matching de contato→cliente.
 *
 * A API só busca cliente por CPF exato (não por telefone). Como o que temos do
 * WhatsApp é o telefone, mantemos um ÍNDICE em memória (telefone normalizado →
 * cliente), reconstruído sob demanda e a cada algumas horas via paginação de
 * GET /clientes. Em cada arquivo: acha pelo telefone; se não achar, cria um
 * "contato" (sem CPF, que o WhatsApp não fornece) e pega o e-mail exclusivo.
 *
 * DESLIGADO até setar TRAMITACAO_API_TOKEN.
 */
export interface TramCustomer {
  id: number;
  email: string | null;
  name: string | null;
}

const DEFAULT_BASE = 'https://planilha.tramitacaointeligente.com.br/api/v1';
const STALE_MS = 3 * 60 * 60 * 1000; // 3h

@Injectable()
export class TramitacaoService {
  private readonly logger = new Logger(TramitacaoService.name);
  private index: Map<string, TramCustomer> | null = null;
  private lastSync = 0;
  private syncing: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {}

  private get token() {
    return this.config.get<string>('TRAMITACAO_API_TOKEN');
  }
  private get base() {
    return this.config.get<string>('TRAMITACAO_BASE_URL') ?? DEFAULT_BASE;
  }

  isEnabled(): boolean {
    return !!this.token;
  }

  /** Normaliza telefone BR para DDD+8dígitos (remove 55 e o 9º dígito). */
  normalizePhone(raw: string | null | undefined): string {
    let n = (raw ?? '').replace(/\D/g, '');
    if (!n) return '';
    if (n.length > 11 && n.startsWith('55')) n = n.slice(2);
    if (n.length === 11 && n[2] === '9') n = n.slice(0, 2) + n.slice(3);
    return n;
  }

  private async api<T = any>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T | null }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const opt: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      };
      const res = await fetch(this.base + path, opt);
      if (res.status === 522) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      return { status: res.status, data };
    }
    return { status: 522, data: null };
  }

  private async ensureIndex(): Promise<void> {
    if (this.index && Date.now() - this.lastSync < STALE_MS) return;
    if (this.syncing) return this.syncing;
    this.syncing = this.buildIndex().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async buildIndex(): Promise<void> {
    const map = new Map<string, TramCustomer>();
    let page = 1;
    for (; page <= 300; page++) {
      const { status, data } = await this.api('GET', `/clientes?per_page=100&page=${page}`);
      const list: any[] = (data && data.customers) || [];
      if (status !== 200 || list.length === 0) break;
      for (const c of list) {
        const cust: TramCustomer = {
          id: c.id,
          email: c.email_exclusivo ?? null,
          name: c.name ?? null,
        };
        for (const ph of [c.phone_mobile, c.phone_1, c.phone_2]) {
          const k = this.normalizePhone(ph);
          if (k && !map.has(k)) map.set(k, cust);
        }
      }
      if (list.length < 100) break;
    }
    this.index = map;
    this.lastSync = Date.now();
    this.logger.log(`Tramitação: índice de clientes atualizado (${map.size} telefones)`);
  }

  async findByPhone(phone: string): Promise<TramCustomer | null> {
    await this.ensureIndex();
    const k = this.normalizePhone(phone);
    if (!k) return null;
    return this.index?.get(k) ?? null;
  }

  /** Cria um "contato" (sem CPF) e garante o e-mail exclusivo. */
  async createContato(name: string | null, phone: string): Promise<TramCustomer | null> {
    const { status, data } = await this.api('POST', '/clientes', {
      customer: {
        name: (name && name.trim()) || `Contato ${phone}`,
        customer_type: 'contato',
        phone_mobile: (phone || '').replace(/\D/g, '').slice(-11),
      },
    });
    const id = data && (data.customer ? data.customer.id : data.id);
    if (status >= 300 || !id) {
      this.logger.warn(`Tramitação: falha ao criar contato (${status})`);
      return null;
    }
    const email = await this.ensureEmail(id);
    const cust: TramCustomer = { id, email, name };
    const k = this.normalizePhone(phone);
    if (k) this.index?.set(k, cust);
    return cust;
  }

  /** Retorna (criando se preciso) o e-mail exclusivo do cliente. */
  async ensureEmail(customerId: number): Promise<string | null> {
    const { status, data } = await this.api('POST', `/clientes/${customerId}/emails/address`, {});
    if (status >= 300) {
      this.logger.warn(
        `Tramitação: falha ao obter e-mail exclusivo do cliente ${customerId} (${status})`,
      );
      return null;
    }
    return (data && (data.email ?? data.email_exclusivo ?? data.address)) ?? null;
  }
}
