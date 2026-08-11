import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payload devolvido pelo popup de Embedded Signup da Meta (coexistência).
 * O front captura `code` (via FB.login), `phoneNumberId` e `wabaId` (via
 * evento `WA_EMBEDDED_SIGNUP`) e envia pra cá; o backend troca o code por
 * token, assina o app na WABA e cria o canal WHATSAPP_OFFICIAL.
 */
export class EmbeddedSignupDto {
  @ApiProperty({ description: 'Authorization code do FB.login (response_type=code)' })
  @IsString()
  code: string;

  @ApiProperty({ description: 'phone_number_id retornado pelo Embedded Signup' })
  @IsString()
  phoneNumberId: string;

  @ApiProperty({ description: 'waba_id (WhatsApp Business Account) retornado pelo fluxo' })
  @IsString()
  wabaId: string;

  @ApiPropertyOptional({ description: 'Nome do canal (default: número/nome verificado)' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: ['ORG', 'PRIVATE'] })
  @IsOptional()
  @IsIn(['ORG', 'PRIVATE'])
  visibility?: 'ORG' | 'PRIVATE';
}
