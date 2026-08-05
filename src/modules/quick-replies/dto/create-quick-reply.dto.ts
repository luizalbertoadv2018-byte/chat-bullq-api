import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsInt,
  IsIn,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Um anexo de mídia de uma resposta rápida. A URL já foi gerada pelo upload
 * (`POST /messages/uploads/media`) — aqui só guardamos a referência p/ reenviar
 * depois sem re-upload.
 */
export class QuickReplyAttachmentDto {
  @ApiProperty({ description: 'Tipo da mídia', enum: ['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO'] })
  @IsIn(['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO'])
  type: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'AUDIO';

  @ApiProperty({ description: 'URL pública/servida do arquivo' })
  @IsString()
  @MaxLength(2000)
  url: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  mimeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  fileName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  size?: number;
}

export class CreateQuickReplyDto {
  @ApiProperty({ description: 'Atalho digitado após "/" (ex.: "bomdia")' })
  @IsString()
  @MaxLength(60)
  shortcut: string;

  @ApiProperty({ description: 'Título amigável exibido na lista' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ description: 'Texto da mensagem (opcional se houver anexo)' })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  content?: string;

  @ApiPropertyOptional({ type: [QuickReplyAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuickReplyAttachmentDto)
  attachments?: QuickReplyAttachmentDto[];
}
