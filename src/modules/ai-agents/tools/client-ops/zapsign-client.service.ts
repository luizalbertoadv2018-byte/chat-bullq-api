import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

const DEFAULT_BASE_URL = 'https://api.zapsign.com.br/api/v1';

export interface ZapSignSignerInput {
  /** Nome completo do signatário. */
  name: string;
  /** E-mail (usado p/ enviar o link automaticamente, se habilitado). */
  email?: string;
  /** DDI, ex.: "55". Só necessário se for enviar por WhatsApp. */
  phoneCountry?: string;
  /** Número com DDD, ex.: "11999999999". */
  phoneNumber?: string;
  /** CPF do signatário (opcional — reforça a validação). */
  cpf?: string;
}

export interface ZapSignCreateDocInput {
  /** Nome do documento como aparece no painel/e-mail. */
  name: string;
  /** URL pública (HTTPS) do PDF a ser assinado. */
  pdfUrl: string;
  signers: ZapSignSignerInput[];
  /** Enviar o link por e-mail automaticamente. Default true. */
  sendAutomaticEmail?: boolean;
  /** Enviar o link por WhatsApp automaticamente. Default false. */
  sendAutomaticWhatsapp?: boolean;
  /** Idioma do fluxo de assinatura. Default "pt-br". */
  lang?: string;
}

export interface ZapSignCreateDocBase64Input
  extends Omit<ZapSignCreateDocInput, 'pdfUrl'> {
  /** PDF em base64 puro (sem prefixo data:). */
  base64Pdf: string;
}

/** Uma variável do modelo → valor. `de` é o placeholder exato (ex.: "{{nome}}"). */
export interface ZapSignTemplateVar {
  de: string;
  para: string;
}

export interface ZapSignCreateFromTemplateInput {
  /** Token do modelo salvo na ZapSign. */
  templateId: string;
  /** Nome do signatário. */
  signer: ZapSignSignerInput;
  /** Variáveis do modelo já mapeadas (placeholder → valor). */
  data: ZapSignTemplateVar[];
  sendAutomaticEmail?: boolean;
  sendAutomaticWhatsapp?: boolean;
  lang?: string;
}

export interface ZapSignTemplateSummary {
  token: string;
  name: string;
}

interface ZapSignApiSigner {
  token?: string;
  name?: string;
  email?: string;
  status?: string;
  sign_url?: string;
}

interface ZapSignApiDoc {
  token?: string;
  name?: string;
  status?: string;
  created_at?: string;
  signers?: ZapSignApiSigner[];
}

/**
 * Cliente da API de assinatura digital ZapSign (conta do ESCRITÓRIO — não é
 * credencial por cliente como o Hoppe). Fala com a API v1 usando o token
 * `ZAPSIGN_API_TOKEN`. Usado pelo agente jurídico p/ enviar procurações e
 * contratos de honorários para o cliente assinar sem humano no meio.
 *
 * Docs: https://docs.zapsign.com.br/
 */
@Injectable()
export class ZapSignClientService {
  private readonly logger = new Logger(ZapSignClientService.name);
  private readonly token: string | undefined;
  private readonly http: AxiosInstance;

  constructor(config: ConfigService) {
    this.token = config.get<string>('ZAPSIGN_API_TOKEN')?.trim() || undefined;
    const baseURL =
      config.get<string>('ZAPSIGN_BASE_URL')?.trim() || DEFAULT_BASE_URL;

    if (!this.token) {
      this.logger.warn(
        'ZAPSIGN_API_TOKEN não configurado — envio de documentos p/ assinatura fica inerte',
      );
    }

    this.http = axios.create({
      baseURL: baseURL.replace(/\/$/, ''),
      timeout: 20_000,
      headers: this.token
        ? { Authorization: `Bearer ${this.token}` }
        : undefined,
    });
  }

  isConfigured(): boolean {
    return !!this.token;
  }

  /**
   * Cria um documento a partir de um PDF público e dispara o fluxo de
   * assinatura. Retorna o token do documento e o link de cada signatário.
   */
  async createDocumentFromUrl(input: ZapSignCreateDocInput): Promise<{
    docToken: string;
    status: string;
    signers: Array<{
      name: string;
      status: string;
      signUrl: string | null;
    }>;
  }> {
    const body = {
      name: input.name,
      url_pdf: input.pdfUrl,
      lang: input.lang ?? 'pt-br',
      signers: this.buildSigners(input),
    };

    const { data } = await this.http.post<ZapSignApiDoc>('/docs/', body);
    return this.normalizeDoc(data);
  }

  /**
   * Cria o documento a partir de um PDF em base64 (não exige URL pública —
   * ideal quando a API roda em localhost e não pode ser alcançada pela
   * ZapSign). Dispara o fluxo de assinatura igual ao createDocumentFromUrl.
   */
  async createDocumentFromBase64(input: ZapSignCreateDocBase64Input): Promise<{
    docToken: string;
    status: string;
    signers: Array<{ name: string; status: string; signUrl: string | null }>;
  }> {
    const body = {
      name: input.name,
      base64_pdf: input.base64Pdf,
      lang: input.lang ?? 'pt-br',
      signers: this.buildSigners(input),
    };

    const { data } = await this.http.post<ZapSignApiDoc>('/docs/', body);
    return this.normalizeDoc(data);
  }

  /**
   * Cria um documento a partir de um MODELO salvo na ZapSign, preenchendo as
   * variáveis (`data`). É o fluxo do LiderHub: o modelo (contrato de
   * honorários, procuração) fica salvo na ZapSign com placeholders tipo
   * `{{nome}}` e o agente só manda os dados do lead. Endpoint:
   * `POST /models/create-doc/`.
   */
  async createDocumentFromTemplate(
    input: ZapSignCreateFromTemplateInput,
  ): Promise<{
    docToken: string;
    status: string;
    signers: Array<{ name: string; status: string; signUrl: string | null }>;
  }> {
    const s = input.signer;
    const body: Record<string, unknown> = {
      template_id: input.templateId,
      signer_name: s.name,
      lang: input.lang ?? 'pt-br',
      send_automatic_email: input.sendAutomaticEmail ?? true,
      send_automatic_whatsapp: input.sendAutomaticWhatsapp ?? false,
      ...(s.email ? { signer_email: s.email } : {}),
      ...(s.phoneCountry ? { phone_country: s.phoneCountry } : {}),
      ...(s.phoneNumber ? { phone_number: s.phoneNumber } : {}),
      data: input.data,
    };

    const { data } = await this.http.post<ZapSignApiDoc>(
      '/models/create-doc/',
      body,
    );
    return this.normalizeDoc(data);
  }

  /** Lista os modelos (templates) salvos na conta ZapSign do escritório. */
  async listTemplates(): Promise<ZapSignTemplateSummary[]> {
    const { data } = await this.http.get<unknown>('/templates/');
    // A API pode devolver array puro ou paginado ({results:[...]}).
    const rows: any[] = Array.isArray(data)
      ? data
      : ((data as { results?: any[] })?.results ?? []);
    return rows
      .map((r) => ({
        token: String(r?.token ?? r?.id ?? ''),
        name: String(r?.name ?? r?.title ?? '(sem nome)'),
      }))
      .filter((t) => t.token);
  }

  /** Detalhe cru de um modelo (inclui as variáveis, p/ o operador conferir). */
  async getTemplate(templateToken: string): Promise<unknown> {
    const { data } = await this.http.get<unknown>(
      `/templates/${encodeURIComponent(templateToken)}/`,
    );
    return data;
  }

  /**
   * Variáveis (campos dinâmicos) de um modelo. Cada `variable` é o placeholder
   * exato usado no data[].de (ex.: "{{Nome Completo}}"); `label` é o nome
   * amigável do campo (ex.: "Nome Completo").
   */
  async getTemplateInputs(templateToken: string): Promise<
    Array<{ variable: string; label: string; required: boolean; order: number }>
  > {
    const detail = (await this.getTemplate(templateToken)) as {
      inputs?: Array<{
        variable?: string;
        label?: string;
        required?: boolean;
        order?: number;
      }>;
    };
    const inputs = Array.isArray(detail?.inputs) ? detail.inputs : [];
    return inputs
      .map((i) => ({
        variable: String(i?.variable ?? ''),
        label: String(i?.label ?? i?.variable ?? ''),
        required: i?.required === true,
        order: Number(i?.order ?? 0),
      }))
      .filter((i) => i.variable)
      .sort((a, b) => a.order - b.order);
  }

  private buildSigners(input: {
    signers: ZapSignSignerInput[];
    sendAutomaticEmail?: boolean;
    sendAutomaticWhatsapp?: boolean;
  }): Array<Record<string, unknown>> {
    return input.signers.map((s) => ({
      name: s.name,
      ...(s.email ? { email: s.email } : {}),
      ...(s.phoneCountry ? { phone_country: s.phoneCountry } : {}),
      ...(s.phoneNumber ? { phone_number: s.phoneNumber } : {}),
      ...(s.cpf ? { cpf: s.cpf } : {}),
      auth_mode: 'assinaturaTela',
      send_automatic_email: input.sendAutomaticEmail ?? true,
      send_automatic_whatsapp: input.sendAutomaticWhatsapp ?? false,
    }));
  }

  /** Consulta o status atual de um documento pelo token. */
  async getDocument(docToken: string): Promise<{
    docToken: string;
    status: string;
    signers: Array<{ name: string; status: string; signUrl: string | null }>;
  }> {
    const { data } = await this.http.get<ZapSignApiDoc>(
      `/docs/${encodeURIComponent(docToken)}/`,
    );
    return this.normalizeDoc(data);
  }

  private normalizeDoc(doc: ZapSignApiDoc): {
    docToken: string;
    status: string;
    signers: Array<{ name: string; status: string; signUrl: string | null }>;
  } {
    return {
      docToken: doc.token ?? '',
      status: doc.status ?? 'unknown',
      signers: (doc.signers ?? []).map((s) => ({
        name: s.name ?? '',
        status: s.status ?? 'pending',
        signUrl: s.sign_url ?? null,
      })),
    };
  }
}
