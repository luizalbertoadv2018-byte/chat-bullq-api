import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Public } from '../../../../common/decorators';
import { ZapSignClientService } from '../client-ops/zapsign-client.service';

/**
 * Recebe o webhook da ZapSign quando um documento muda de estado. Nos interessa
 * a ASSINATURA do contrato: é o gatilho que LIBERA o contato — a partir daí o
 * cadastro completo vai pro Tramitação Inteligente e as mídias recebidas são
 * espelhadas (backfill). Antes disso, nada é enviado pro Tramitação (evita
 * poluir a base com leads que nunca viraram cliente).
 *
 * Público (sem JWT) — a autenticação é o segredo na URL
 * (`/webhooks/zapsign/<secret>`, env ZAPSIGN_WEBHOOK_SECRET). Além disso,
 * re-confirmamos a assinatura consultando a ZapSign com o NOSSO token (o
 * payload sozinho não é confiável). Responde 200 rápido e processa async.
 */
@ApiTags('Webhooks')
@Controller('webhooks/zapsign')
export class ZapSignWebhookController {
  private readonly logger = new Logger(ZapSignWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly zapsign: ZapSignClientService,
    @InjectQueue('tramitacao-sync') private readonly queue: Queue,
  ) {}

  @Post(':secret')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Recebe webhook de assinatura de documento da ZapSign' })
  @ApiParam({ name: 'secret', description: 'Segredo configurado na URL' })
  async handle(
    @Param('secret') secret: string,
    @Body() payload: any,
    @Headers() _headers: Record<string, string>,
  ): Promise<{ status: string }> {
    const expected = this.config.get<string>('ZAPSIGN_WEBHOOK_SECRET')?.trim();
    if (!expected || secret !== expected) {
      this.logger.warn('ZapSign webhook com segredo inválido');
      throw new UnauthorizedException('invalid secret');
    }

    const token = this.extractToken(payload);
    if (!token) {
      this.logger.warn('ZapSign webhook sem token de documento');
      return { status: 'no_token' };
    }

    // Re-confirma na fonte: consulta o documento com o nosso token de API.
    let signed = false;
    try {
      const doc = await this.zapsign.getDocument(token);
      signed =
        this.isSignedStatus(doc.status) ||
        (doc.signers.length > 0 &&
          doc.signers.every((s) => this.isSignedStatus(s.status)));
    } catch (err: any) {
      this.logger.warn(
        `ZapSign webhook: falha ao consultar doc ${token}: ${err?.message ?? err}`,
      );
      // Sem conseguir confirmar, não libera. A ZapSign reentrega o webhook.
      return { status: 'confirm_failed' };
    }

    if (!signed) {
      return { status: 'not_signed' };
    }

    await this.queue.add(
      'sync',
      { kind: 'release-by-doc', docToken: token },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );

    this.logger.log(`ZapSign: documento ${token} assinado → release enfileirado`);
    return { status: 'ok' };
  }

  /** Extrai o token do documento das várias formas possíveis do payload. */
  private extractToken(payload: any): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const candidates = [
      payload.token,
      payload.doc_token,
      payload.docToken,
      payload.doc?.token,
      payload.document?.token,
      payload.data?.token,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
  }

  private isSignedStatus(status: string | null | undefined): boolean {
    const s = (status ?? '').toLowerCase();
    return s === 'signed' || s === 'assinado';
  }
}
