import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import {
  DOSSIE_FIELDS,
  DOSSIE_KEYS,
  missingDossieFields,
} from '../../runner/dossie.constants';

/**
 * Grava no dossiê do cliente uma informação colhida na conversa (identificador
 * da conta, data do bloqueio, uso, pedido de revisão, prejuízo...). É o que a
 * equipe usa para redigir a peça. A cada gravação devolve o que ainda falta,
 * para o agente de coleta saber a próxima pergunta sem depender do histórico.
 */
@Injectable()
export class RegistrarDadoDoCasoTool implements AiTool {
  private readonly logger = new Logger(RegistrarDadoDoCasoTool.name);

  readonly name = 'registrarDadoDoCaso';
  readonly description =
    'Registra no dossiê do caso uma informação que o cliente acabou de dar. Chame SEMPRE que ele responder um item do dossiê, com o "campo" certo e o "valor" nas palavras dele (resumido, sem inventar). ' +
    'Se o cliente não souber ou não quiser informar, registre o valor "não informado" para o campo. ' +
    'A resposta traz "faltantes": use para decidir a próxima pergunta. Campos: ' +
    DOSSIE_FIELDS.map((f) => `${f.key} (${f.label})`).join('; ') +
    '.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['campo', 'valor'],
    properties: {
      campo: { type: 'string', enum: [...DOSSIE_KEYS] },
      valor: {
        type: 'string',
        description: 'O que o cliente informou, resumido e fiel.',
        minLength: 1,
        maxLength: 800,
      },
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const campo = String(input.campo ?? '').trim();
    const valor = String(input.valor ?? '').trim();
    if (!DOSSIE_KEYS.includes(campo)) {
      return {
        output: { ok: false, error: 'campo inválido', permitidos: DOSSIE_KEYS },
      };
    }
    if (!valor) {
      return { output: { ok: false, error: 'Informe o valor.' } };
    }

    // Relê na hora: outras escritas (documentos, grupo, liberação) mexem no
    // mesmo metadata e não podem ser atropeladas.
    const contact = await this.prisma.contact.findUnique({
      where: { id: ctx.contactId },
      select: { metadata: true },
    });
    const meta = (contact?.metadata ?? {}) as Record<string, any>;
    const dossie = { ...(meta.dossie ?? {}) } as Record<string, any>;

    // Observações se acumulam; os demais campos são substituídos.
    dossie[campo] =
      campo === 'observacoes' && typeof dossie.observacoes === 'string'
        ? `${dossie.observacoes} | ${valor}`.slice(0, 2000)
        : valor;
    dossie.atualizadoEm = new Date().toISOString();

    const nextMeta = { ...meta, dossie };
    await this.prisma.contact.update({
      where: { id: ctx.contactId },
      data: { metadata: nextMeta as any },
    });

    const faltam = missingDossieFields(nextMeta);
    this.logger.log(
      `dossiê: "${campo}" registrado (contato ${ctx.contactId}); faltam ${faltam.length}`,
    );
    return {
      output: {
        ok: true,
        registrado: campo,
        completo: faltam.length === 0,
        faltantes: faltam.map((f) => ({ campo: f.key, oQueE: f.label })),
      },
    };
  }
}
