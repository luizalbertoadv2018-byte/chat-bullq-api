import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isValidCpf, onlyDigits } from '../../../common/util/cpf.util';

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

/**
 * Cadastro genérico (independente da API) que a Camada 2 empurra pro
 * Tramitação — os dados que os agentes já coletam pra ZapSign. Só os campos
 * presentes são enviados; o resto é ignorado.
 */
export interface TramCadastro {
  name?: string | null;
  cpf?: string | null;
  email?: string | null;
  phone?: string | null;
  maritalStatus?: string | null;
  profession?: string | null;
  rg?: string | null;
  birthdate?: string | null;
  street?: string | null;
  streetNumber?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  zipcode?: string | null;
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

  // ─── Matching por CPF (chave EXATA — o pulo do gato) ──────────────────────

  private toCustomer(c: any): TramCustomer {
    return { id: c.id, email: c.email_exclusivo ?? null, name: c.name ?? null };
  }

  private indexPhones(c: any, cust: TramCustomer) {
    for (const ph of [c.phone_mobile, c.phone_1, c.phone_2]) {
      const k = this.normalizePhone(ph);
      if (k) this.index?.set(k, cust);
    }
  }

  /**
   * Busca o cliente pelo CPF (correspondência EXATA — a API só casa por
   * cpf_cnpj). Devolve null se o CPF for inválido ou não existir lá.
   */
  async findByCpf(cpf: string | null | undefined): Promise<TramCustomer | null> {
    const digits = onlyDigits(cpf);
    if (!isValidCpf(digits)) return null;
    const { status, data } = await this.api('GET', `/clientes?cpf_cnpj=${digits}`);
    if (status !== 200) return null;
    const list: any[] = (data && data.customers) || [];
    const c = list[0];
    if (!c) return null;
    const cust = this.toCustomer(c);
    this.indexPhones(c, cust);
    return cust;
  }

  /** PATCH em um cliente. Devolve true se aplicou. */
  async updateCustomer(id: number, fields: Record<string, unknown>): Promise<boolean> {
    const { status } = await this.api('PATCH', `/clientes/${id}`, { customer: fields });
    if (status >= 300) {
      this.logger.warn(`Tramitação: PATCH cliente ${id} falhou (${status})`);
      return false;
    }
    return true;
  }

  /**
   * Cria um registro no Tramitação com os campos dados. **Só cria como
   * "cliente" se houver CPF** — a API do Tramitação exige CPF pro tipo
   * "cliente" (retorna 422 sem ele). Sem CPF, cria como "contato" (que não
   * exige) e o upgrade contato→cliente acontece depois, quando o CPF chegar.
   */
  async createCliente(fields: Record<string, unknown>): Promise<TramCustomer | null> {
    const customerType =
      (fields.customer_type as string) || (fields.cpf_cnpj ? 'cliente' : 'contato');
    const { status, data } = await this.api('POST', '/clientes', {
      customer: { ...fields, customer_type: customerType },
    });
    const id = data && (data.customer ? data.customer.id : data.id);
    if (status >= 300 || !id) {
      this.logger.warn(`Tramitação: criar registro falhou (${status})`);
      return null;
    }
    const email = await this.ensureEmail(id);
    const cust: TramCustomer = { id, email, name: (fields.name as string) ?? null };
    const k = this.normalizePhone(fields.phone_mobile as string);
    if (k) this.index?.set(k, cust);
    return cust;
  }

  /**
   * Reconcilia um contato com o Tramitação usando o CPF. Ordem:
   *   1. acha por CPF → usa (casamento 100% confiável, sem duplicar);
   *   2. senão, se já existe um cliente vinculado (contato criado antes pelo
   *      telefone) → faz UPGRADE dele pra "cliente" com CPF (sem duplicar);
   *   3. senão, se existe um contato casado pelo telefone → mesmo upgrade;
   *   4. senão, cria um cliente novo já com CPF.
   * Devolve o cliente resultante (com e-mail exclusivo garantido) ou null.
   */
  async reconcileByCpf(params: {
    cpf: string;
    name?: string | null;
    phone?: string | null;
    linkedCustomerId?: number | null;
  }): Promise<TramCustomer | null> {
    const digits = onlyDigits(params.cpf);
    if (!isValidCpf(digits)) return null;
    const phoneMobile = params.phone ? onlyDigits(params.phone).slice(-11) : undefined;

    // 1) já existe cliente com esse CPF no Tramitação.
    const byCpf = await this.findByCpf(digits);
    if (byCpf) {
      if (!byCpf.email) byCpf.email = await this.ensureEmail(byCpf.id);
      return byCpf;
    }

    // Campos de upgrade: vira "cliente", ganha CPF (e nome/telefone se faltavam).
    const upgrade: Record<string, unknown> = {
      customer_type: 'cliente',
      cpf_cnpj: digits,
    };
    if (params.name && params.name.trim()) upgrade.name = params.name.trim();
    if (phoneMobile) upgrade.phone_mobile = phoneMobile;

    // 2) cliente já vinculado a este contato (criado antes pelo telefone).
    if (params.linkedCustomerId) {
      const ok = await this.updateCustomer(params.linkedCustomerId, upgrade);
      if (ok) {
        const email = await this.ensureEmail(params.linkedCustomerId);
        const cust: TramCustomer = {
          id: params.linkedCustomerId,
          email,
          name: params.name ?? null,
        };
        const k = this.normalizePhone(params.phone ?? undefined);
        if (k) this.index?.set(k, cust);
        return cust;
      }
    }

    // 3) contato casado pelo telefone (índice em memória).
    const byPhone = params.phone ? await this.findByPhone(params.phone) : null;
    if (byPhone) {
      const ok = await this.updateCustomer(byPhone.id, upgrade);
      if (ok) {
        if (!byPhone.email) byPhone.email = await this.ensureEmail(byPhone.id);
        return byPhone;
      }
    }

    // 4) nada casou → cria cliente novo já com CPF.
    return this.createCliente({
      cpf_cnpj: digits,
      name: (params.name && params.name.trim()) || `Cliente ${digits}`,
      ...(phoneMobile ? { phone_mobile: phoneMobile } : {}),
    });
  }

  /** Traduz o cadastro genérico → campos da API do Tramitação (só os preenchidos). */
  private cadastroToFields(cad: TramCadastro): Record<string, unknown> {
    const f: Record<string, unknown> = {};
    const put = (key: string, val: string | null | undefined) => {
      const v = (val ?? '').trim();
      if (v) f[key] = v;
    };
    put('name', cad.name);
    const cpf = onlyDigits(cad.cpf);
    if (isValidCpf(cpf)) f.cpf_cnpj = cpf;
    put('email', cad.email);
    if (cad.phone) {
      const pm = onlyDigits(cad.phone).slice(-11);
      if (pm) f.phone_mobile = pm;
    }
    put('marital_status', cad.maritalStatus);
    put('profession', cad.profession);
    put('rg_numero', cad.rg);
    put('birthdate', cad.birthdate);
    put('street', cad.street);
    put('street_number', cad.streetNumber);
    put('neighborhood', cad.neighborhood);
    put('city', cad.city);
    put('state', cad.state);
    put('zipcode', cad.zipcode);
    return f;
  }

  /**
   * Camada 2 — empurra um cadastro COMPLETO pro Tramitação (dados que os
   * agentes coletam pra ZapSign). Reconcilia por CPF (ou telefone) e preenche
   * o cliente com todos os campos disponíveis. Cria como "cliente" se não
   * existir. Devolve o cliente ou null.
   */
  async pushCadastro(cad: TramCadastro): Promise<TramCustomer | null> {
    const fields = this.cadastroToFields(cad);
    if (!fields.name && !fields.cpf_cnpj) return null; // sem chave mínima

    if (fields.cpf_cnpj) {
      const existing = await this.findByCpf(fields.cpf_cnpj as string);
      if (existing) {
        await this.updateCustomer(existing.id, fields);
        if (!existing.email) existing.email = await this.ensureEmail(existing.id);
        return existing;
      }
    }

    const byPhone = cad.phone ? await this.findByPhone(cad.phone) : null;
    if (byPhone) {
      await this.updateCustomer(byPhone.id, { customer_type: 'cliente', ...fields });
      if (!byPhone.email) byPhone.email = await this.ensureEmail(byPhone.id);
      return byPhone;
    }

    return this.createCliente(fields);
  }

  /** Garante o cliente para um contato, preferindo o já vinculado. Usado pela
   *  esteira de mídia: se o contato já foi casado por CPF, reusa aquele id. */
  async resolveForMedia(params: {
    linkedCustomerId?: number | null;
    name?: string | null;
    phone: string;
  }): Promise<TramCustomer | null> {
    if (params.linkedCustomerId) {
      const email = await this.ensureEmail(params.linkedCustomerId);
      return { id: params.linkedCustomerId, email, name: params.name ?? null };
    }
    let customer = await this.findByPhone(params.phone);
    if (!customer) {
      customer = await this.createContato(params.name ?? null, params.phone);
    }
    return customer;
  }
}
