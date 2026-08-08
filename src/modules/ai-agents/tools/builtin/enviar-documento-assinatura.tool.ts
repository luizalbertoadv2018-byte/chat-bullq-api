import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { ZapSignClientService } from '../client-ops/zapsign-client.service';
import { DocumentPdfService } from '../client-ops/document-pdf.service';

/**
 * Envia um documento (procuração, contrato de honorários, etc.) para o
 * cliente assinar digitalmente via ZapSign, ou consulta o status de um
 * documento já enviado. Usa a conta ZapSign do escritório (token no
 * servidor). O PDF precisa estar acessível por uma URL pública (HTTPS).
 */
@Injectable()
export class EnviarDocumentoAssinaturaTool implements AiTool {
  private readonly logger = new Logger(EnviarDocumentoAssinaturaTool.name);

  readonly name = 'enviarDocumentoAssinatura';
  readonly description =
    'Envia documentos (contrato de honorários, procuração) para o cliente assinar digitalmente pela ZapSign, gera a partir de modelos salvos ou de texto, e consulta status. ' +
    'Ações: ' +
    '"detalharModelo" → mostra os CAMPOS que um modelo pede (use antes p/ saber o que coletar do lead). Passe nomeModelo ou templateId. ' +
    '"enviarModelo" (RECOMENDADO) → usa um MODELO já salvo na ZapSign. Passe o "nomeModelo" (ou "templateId"), os dados coletados do lead em "variaveis" (chave = nome do campo do modelo, ex.: {"Nome Completo":"João","CPF":"000...","Estado Civil":"casado","profissão":"pedreiro"}) e o signatário. A ZapSign preenche o modelo e gera o contrato pronto. O sistema casa os campos automaticamente mesmo com pequenas diferenças de grafia. ' +
    '"listarModelos" → lista os modelos disponíveis na conta (nome + id). ' +
    '"enviar" → gera um PDF na hora a partir do TEXTO em "conteudo" (quando não há modelo salvo) OU de uma "pdfUrl" pronta. ' +
    '"consultarStatus" (docToken) → devolve se já foi assinado. ' +
    'Use quando o cliente aceitar assinar. Colete antes os dados que o modelo pede (nome, estado civil, profissão, CPF, endereço, etc.).';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['acao'],
    properties: {
      acao: {
        type: 'string',
        enum: [
          'detalharModelo',
          'enviarModelo',
          'listarModelos',
          'enviar',
          'consultarStatus',
        ],
      },
      nomeModelo: {
        type: 'string',
        description:
          'Em enviarModelo: nome do modelo salvo na ZapSign (ex.: "Contrato de Honorários"). Match parcial e sem acento. Alternativa ao templateId.',
        maxLength: 200,
      },
      templateId: {
        type: 'string',
        description:
          'Em enviarModelo: token do modelo salvo na ZapSign. Alternativa ao nomeModelo.',
        maxLength: 100,
      },
      variaveis: {
        type: 'object',
        description:
          'Em enviarModelo: dados coletados do lead p/ preencher o modelo. Chave = nome da variável do modelo (ex.: "nome", "cpf", "estado_civil"), valor = o dado. Ex.: {"nome":"João Silva","cpf":"000.000.000-00","profissao":"pedreiro"}.',
        additionalProperties: { type: 'string' },
      },
      nomeDocumento: {
        type: 'string',
        description:
          'Em enviar: nome do documento (ex.: "Contrato de Honorários - João Silva").',
        maxLength: 200,
      },
      conteudo: {
        type: 'string',
        description:
          'Em enviar: texto completo do documento a ser gerado em PDF. Parágrafos separados por linha em branco. Use isto quando você mesmo redige o documento (procuração, contrato). Obrigatório se não passar pdfUrl.',
        maxLength: 20000,
      },
      pdfUrl: {
        type: 'string',
        description:
          'Em enviar: URL pública HTTPS de um PDF já pronto. Alternativa ao "conteudo". Só use uma URL que você realmente tenha.',
        maxLength: 2000,
      },
      signatarioNome: {
        type: 'string',
        description: 'Em enviar: nome completo de quem vai assinar.',
        maxLength: 200,
      },
      signatarioEmail: {
        type: 'string',
        description:
          'Em enviar: e-mail do signatário (recebe o link automaticamente).',
        maxLength: 200,
      },
      signatarioTelefone: {
        type: 'string',
        description:
          'Em enviar: telefone com DDD (só números, ex.: "11999999999"). Opcional.',
        maxLength: 20,
      },
      signatarioCpf: {
        type: 'string',
        description: 'Em enviar: CPF do signatário (opcional).',
        maxLength: 14,
      },
      enviarWhatsapp: {
        type: 'boolean',
        description:
          'Em enviar: também mandar o link por WhatsApp (exige telefone). Default false.',
      },
      docToken: {
        type: 'string',
        description: 'Em consultarStatus: token do documento retornado no envio.',
        maxLength: 100,
      },
    },
  };

  constructor(
    private readonly zapsign: ZapSignClientService,
    private readonly pdf: DocumentPdfService,
    @InjectQueue('tramitacao-sync') private readonly tramitacaoQueue: Queue,
  ) {}

  /**
   * Camada 2 — quando o agente envia um documento (contrato/procuração), ele
   * já coletou o cadastro completo do cliente (nome, CPF, estado civil,
   * profissão, endereço...). Aproveitamos esses mesmos dados pra criar/atualizar
   * o cliente no Tramitação Inteligente, já preenchido. Fire-and-forget: nunca
   * atrapalha o envio da assinatura. No-op se o Tramitação estiver desligado
   * (o processor descarta o job).
   */
  private pushCadastroToTramitacao(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): void {
    try {
      const cadastro = this.buildCadastro(input);
      if (!cadastro.name && !cadastro.cpf) return; // sem chave mínima
      void this.tramitacaoQueue
        .add(
          'sync',
          {
            kind: 'cadastro',
            organizationId: ctx.organizationId,
            contactId: ctx.contactId,
            cadastro,
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 8000 },
            removeOnComplete: true,
            removeOnFail: 50,
          },
        )
        .catch((err) =>
          this.logger.warn(
            `tramitação(cadastro) enqueue falhou (run=${ctx.runId}): ${err?.message ?? err}`,
          ),
        );
    } catch (err: any) {
      this.logger.warn(
        `tramitação(cadastro) build falhou (run=${ctx.runId}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Mapeia as `variaveis` do modelo (chaves em português livre, ex.: "Nome
   * Completo", "Estado Civil", "Endereço") + os dados do signatário para o
   * cadastro genérico do Tramitação. Casa por palavra-chave sem acento.
   */
  private buildCadastro(input: Record<string, unknown>): {
    name?: string;
    cpf?: string;
    email?: string;
    phone?: string;
    maritalStatus?: string;
    profession?: string;
    rg?: string;
    birthdate?: string;
    street?: string;
    streetNumber?: string;
    neighborhood?: string;
    city?: string;
    state?: string;
    zipcode?: string;
  } {
    const vars =
      input.variaveis &&
      typeof input.variaveis === 'object' &&
      !Array.isArray(input.variaveis)
        ? (input.variaveis as Record<string, unknown>)
        : {};

    // Índice normalizado (sem acento, minúsculo) → valor.
    const lookup = new Map<string, string>();
    for (const [k, v] of Object.entries(vars)) {
      const val = v == null ? '' : String(v).trim();
      if (val) lookup.set(this.normalizeText(k), val);
    }
    // Acha o primeiro valor cuja chave contém QUALQUER um dos termos.
    const pick = (...terms: string[]): string | undefined => {
      for (const [k, v] of lookup) {
        if (terms.some((t) => k.includes(t))) return v;
      }
      return undefined;
    };
    // Variante com predicado — para casos ambíguos (ex.: "estado" da UF NÃO
    // pode casar "estado civil").
    const pickBy = (pred: (k: string) => boolean): string | undefined => {
      for (const [k, v] of lookup) {
        if (pred(k)) return v;
      }
      return undefined;
    };

    const signerNome = String(input.signatarioNome ?? '').trim() || undefined;
    const signerEmail = String(input.signatarioEmail ?? '').trim() || undefined;
    const signerTel = String(input.signatarioTelefone ?? '').trim() || undefined;
    const signerCpf = String(input.signatarioCpf ?? '').trim() || undefined;

    const cad = {
      name: pick('nome') ?? signerNome,
      cpf: pick('cpf') ?? signerCpf,
      email: pick('email', 'e-mail') ?? signerEmail,
      phone: pick('telefone', 'celular', 'whatsapp', 'fone') ?? signerTel,
      maritalStatus: pick('estado civil', 'civil'),
      profession: pick('profiss', 'ocupac'),
      rg: pick('rg', 'identidade'),
      birthdate: pick('nascimento', 'data de nasc'),
      street: pick('logradouro', 'endereco', 'rua', 'avenida'),
      streetNumber: pick('numero', 'nº', 'n°'),
      neighborhood: pick('bairro'),
      city: pick('cidade', 'municipio'),
      // "estado" da UF, mas nunca "estado civil".
      state: pickBy((k) => k === 'uf' || (k.includes('estado') && !k.includes('civil'))),
      zipcode: pick('cep'),
    };
    // Remove chaves undefined pra manter o payload enxuto.
    return Object.fromEntries(
      Object.entries(cad).filter(([, v]) => v !== undefined),
    ) as any;
  }

  /** Extrai os dados do signatário do input (formato ZapSignSignerInput). */
  private readSigner(input: Record<string, unknown>): {
    name: string;
    email?: string;
    phoneCountry?: string;
    phoneNumber?: string;
    cpf?: string;
  } {
    const name = String(input.signatarioNome ?? '').trim();
    const email = String(input.signatarioEmail ?? '').trim();
    const phone = String(input.signatarioTelefone ?? '').trim();
    return {
      name,
      email: email || undefined,
      phoneCountry: phone ? '55' : undefined,
      phoneNumber: phone || undefined,
      cpf: input.signatarioCpf ? String(input.signatarioCpf).trim() : undefined,
    };
  }

  /**
   * Resolve o modelo por templateId direto ou por nomeModelo (match parcial,
   * sem acento). Devolve o token ou um output de erro pronto.
   */
  private async resolveTemplateId(
    input: Record<string, unknown>,
  ): Promise<{ templateId?: string; errorOutput?: unknown }> {
    const templateId = String(input.templateId ?? '').trim();
    if (templateId) return { templateId };

    const nomeModelo = String(input.nomeModelo ?? '').trim();
    if (!nomeModelo) {
      return {
        errorOutput: {
          ok: false,
          error:
            'Informe o templateId ou o nomeModelo do modelo (use listarModelos p/ ver os disponíveis).',
        },
      };
    }

    const templates = await this.zapsign.listTemplates();
    const alvo = this.normalizeText(nomeModelo);
    const matches = templates.filter((t) =>
      this.normalizeText(t.name).includes(alvo),
    );
    if (matches.length === 0) {
      return {
        errorOutput: {
          ok: false,
          error: `Nenhum modelo com nome parecido com "${nomeModelo}".`,
          modelosDisponiveis: templates,
        },
      };
    }
    if (matches.length > 1) {
      return {
        errorOutput: {
          ok: false,
          error: `Mais de um modelo bate com "${nomeModelo}" — confirme qual.`,
          candidatos: matches,
        },
      };
    }
    return { templateId: matches[0].token };
  }

  /** Normaliza p/ comparação: sem acento, minúsculo. */
  private normalizeText(s: string): string {
    // Decompõe (NFD) e remove os combining marks (U+0300–U+036F) por
    // codepoint — evita literais de diacríticos no código-fonte.
    return Array.from(s.normalize('NFD'))
      .filter((ch) => {
        const c = ch.codePointAt(0) ?? 0;
        return c < 0x0300 || c > 0x036f;
      })
      .join('')
      .toLowerCase()
      .trim();
  }

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!this.zapsign.isConfigured()) {
      return {
        output: {
          ok: false,
          error:
            'ZapSign ainda não configurada no servidor (ZAPSIGN_API_TOKEN). Avise o operador.',
        },
      };
    }

    const acao = String(input.acao ?? '');

    try {
      if (acao === 'consultarStatus') {
        const docToken = String(input.docToken ?? '').trim();
        if (!docToken) {
          return {
            output: { ok: false, error: 'docToken é obrigatório em consultarStatus.' },
          };
        }
        const doc = await this.zapsign.getDocument(docToken);
        this.logger.log(
          `zapsign consultarStatus doc=${docToken} status=${doc.status} (run=${ctx.runId})`,
        );
        return { output: { ok: true, ...doc } };
      }

      if (acao === 'listarModelos') {
        const templates = await this.zapsign.listTemplates();
        this.logger.log(
          `zapsign listarModelos n=${templates.length} (run=${ctx.runId})`,
        );
        return {
          output: {
            ok: true,
            total: templates.length,
            modelos: templates,
            instrucao: templates.length
              ? 'Use enviarModelo com o nomeModelo (ou templateId) e as variaveis coletadas do lead.'
              : 'Nenhum modelo salvo na conta ZapSign. Cadastre o modelo no painel da ZapSign primeiro.',
          },
        };
      }

      if (acao === 'detalharModelo') {
        const resolved = await this.resolveTemplateId(input);
        if (!resolved.templateId) {
          return { output: resolved.errorOutput };
        }
        const inputs = await this.zapsign.getTemplateInputs(resolved.templateId);
        this.logger.log(
          `zapsign detalharModelo template=${resolved.templateId} campos=${inputs.length} (run=${ctx.runId})`,
        );
        return {
          output: {
            ok: true,
            templateId: resolved.templateId,
            campos: inputs.map((i) => ({
              campo: i.label,
              obrigatorio: i.required,
            })),
            instrucao:
              'Colete esses campos do lead na conversa e depois chame enviarModelo com "variaveis" usando esses nomes de campo como chave.',
          },
        };
      }

      if (acao === 'enviarModelo') {
        const signer = this.readSigner(input);
        if (!signer.name) {
          return { output: { ok: false, error: 'Preciso do signatarioNome.' } };
        }
        if (!signer.email && !signer.phoneNumber) {
          return {
            output: {
              ok: false,
              error:
                'Preciso do e-mail OU do telefone do signatário para enviar o link.',
            },
          };
        }

        const resolved = await this.resolveTemplateId(input);
        if (!resolved.templateId) {
          return { output: resolved.errorOutput };
        }
        const templateId = resolved.templateId;

        const variaveis =
          input.variaveis &&
          typeof input.variaveis === 'object' &&
          !Array.isArray(input.variaveis)
            ? (input.variaveis as Record<string, unknown>)
            : {};

        // Busca os campos reais do modelo e casa com os dados coletados,
        // gerando data[] com o placeholder EXATO (ex.: "{{Nome Completo}}").
        // Se a busca falhar, cai no modo simples (envolve a chave em {{}}).
        let data: Array<{ de: string; para: string }>;
        let faltando: string[] = [];
        try {
          const inputs = await this.zapsign.getTemplateInputs(templateId);
          if (inputs.length > 0) {
            const lookup = new Map<string, string>();
            for (const [k, v] of Object.entries(variaveis)) {
              lookup.set(
                this.normalizeText(k.replace(/[{}]/g, '')),
                v == null ? '' : String(v),
              );
            }
            data = [];
            for (const inp of inputs) {
              const keyLabel = this.normalizeText(inp.label);
              const keyVar = this.normalizeText(inp.variable.replace(/[{}]/g, ''));
              let val = lookup.get(keyLabel) ?? lookup.get(keyVar);
              if (val === undefined) {
                for (const [lk, lv] of lookup) {
                  if (lk.includes(keyLabel) || keyLabel.includes(lk)) {
                    val = lv;
                    break;
                  }
                }
              }
              if (val === undefined || val === '') {
                if (inp.required) faltando.push(inp.label);
              } else {
                data.push({ de: inp.variable, para: val });
              }
            }
            if (faltando.length > 0) {
              return {
                output: {
                  ok: false,
                  error: `Faltam dados obrigatórios do modelo: ${faltando.join(', ')}. Colete esses campos com o cliente e reenvie.`,
                  camposEsperados: inputs.map((i) => i.label),
                },
              };
            }
          } else {
            data = Object.entries(variaveis).map(([k, v]) => ({
              de: k.includes('{{') ? k : `{{${k}}}`,
              para: v == null ? '' : String(v),
            }));
          }
        } catch {
          // Não conseguiu ler os campos do modelo — modo simples.
          data = Object.entries(variaveis).map(([k, v]) => ({
            de: k.includes('{{') ? k : `{{${k}}}`,
            para: v == null ? '' : String(v),
          }));
        }

        const doc = await this.zapsign.createDocumentFromTemplate({
          templateId,
          signer,
          data,
          sendAutomaticWhatsapp: input.enviarWhatsapp === true,
        });

        this.logger.log(
          `zapsign enviarModelo template=${templateId} vars=${data.length} token=${doc.docToken} (run=${ctx.runId})`,
        );
        // Camada 2: aproveita o cadastro coletado p/ criar/atualizar o cliente
        // no Tramitação, já preenchido.
        this.pushCadastroToTramitacao(input, ctx);
        const linkModelo = doc.signers[0]?.signUrl ?? null;
        return {
          output: {
            ok: true,
            docToken: doc.docToken,
            status: doc.status,
            linkAssinatura: linkModelo,
            signatarios: doc.signers,
            instrucao: linkModelo
              ? 'Contrato gerado do modelo. Compartilhe o linkAssinatura com o cliente (ou ele já recebeu por e-mail/WhatsApp).'
              : 'Contrato gerado do modelo; o link foi enviado ao signatário pelos canais configurados.',
          },
        };
      }

      // acao === 'enviar'
      const nomeDocumento = String(input.nomeDocumento ?? '').trim();
      const conteudo = String(input.conteudo ?? '').trim();
      const pdfUrl = String(input.pdfUrl ?? '').trim();
      const signatarioNome = String(input.signatarioNome ?? '').trim();
      const signatarioEmail = String(input.signatarioEmail ?? '').trim();
      const signatarioTelefone = String(input.signatarioTelefone ?? '').trim();

      if (!nomeDocumento || !signatarioNome) {
        return {
          output: {
            ok: false,
            error: 'Para enviar preciso de: nomeDocumento e signatarioNome.',
          },
        };
      }
      if (!conteudo && !pdfUrl) {
        return {
          output: {
            ok: false,
            error:
              'Preciso do texto do documento em "conteudo" (eu gero o PDF) OU de uma "pdfUrl" pública já pronta.',
          },
        };
      }
      if (pdfUrl && !conteudo && !/^https:\/\//i.test(pdfUrl)) {
        return {
          output: {
            ok: false,
            error: 'pdfUrl precisa ser uma URL pública começando com https://',
          },
        };
      }
      if (!signatarioEmail && !signatarioTelefone) {
        return {
          output: {
            ok: false,
            error:
              'Preciso do e-mail OU do telefone do signatário para enviar o link.',
          },
        };
      }

      const signers = [
        {
          name: signatarioNome,
          email: signatarioEmail || undefined,
          phoneCountry: signatarioTelefone ? '55' : undefined,
          phoneNumber: signatarioTelefone || undefined,
          cpf: input.signatarioCpf
            ? String(input.signatarioCpf).trim()
            : undefined,
        },
      ];
      const sendAutomaticWhatsapp = input.enviarWhatsapp === true;

      // Caminho preferido: agente escreveu o "conteudo" → geramos o PDF e
      // mandamos em base64 (não depende de a API ser pública). Fallback:
      // pdfUrl já pronta.
      let doc;
      let pdfLocalUrl: string | null = null;
      if (conteudo) {
        const generated = await this.pdf.generate({
          title: nomeDocumento,
          body: conteudo,
        });
        pdfLocalUrl = generated.localUrl;
        doc = await this.zapsign.createDocumentFromBase64({
          name: nomeDocumento,
          base64Pdf: generated.base64,
          sendAutomaticWhatsapp,
          signers,
        });
      } else {
        doc = await this.zapsign.createDocumentFromUrl({
          name: nomeDocumento,
          pdfUrl,
          sendAutomaticWhatsapp,
          signers,
        });
      }

      this.logger.log(
        `zapsign enviar doc="${nomeDocumento}" token=${doc.docToken} origem=${conteudo ? 'pdf-gerado' : 'url'} (run=${ctx.runId})`,
      );

      // Camada 2: empurra o cadastro do signatário pro Tramitação.
      this.pushCadastroToTramitacao(input, ctx);

      const link = doc.signers[0]?.signUrl ?? null;
      return {
        output: {
          ok: true,
          docToken: doc.docToken,
          status: doc.status,
          linkAssinatura: link,
          ...(pdfLocalUrl ? { pdfGerado: pdfLocalUrl } : {}),
          signatarios: doc.signers,
          instrucao: link
            ? 'Documento criado. Compartilhe o linkAssinatura com o cliente (ou ele já recebeu por e-mail/WhatsApp se configurado).'
            : 'Documento criado; o link de assinatura foi enviado ao signatário pelos canais configurados.',
        },
      };
    } catch (err: any) {
      const status = err?.response?.status;
      const detail =
        err?.response?.data && typeof err.response.data === 'object'
          ? JSON.stringify(err.response.data).slice(0, 500)
          : err?.message;
      this.logger.error(
        `zapsign ${acao} falhou status=${status ?? '?'}: ${detail}`,
      );
      return {
        output: {
          ok: false,
          error:
            status === 401
              ? 'Token da ZapSign inválido — precisa ser atualizado no servidor.'
              : `Falha na ZapSign: ${detail ?? err?.message}`,
        },
      };
    }
  }
}
