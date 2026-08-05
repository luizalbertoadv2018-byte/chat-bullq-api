import { IsString, IsObject, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateScheduledMessageDto {
  @ApiProperty({ example: 'conversation-id-here' })
  @IsString()
  conversationId: string;

  @ApiProperty({ enum: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'TEMPLATE'] })
  @IsEnum(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'TEMPLATE'])
  type: string;

  @ApiProperty({ example: { text: 'Bom dia! Segue o andamento...' } })
  @IsObject()
  content: Record<string, any>;

  /** Data/hora de envio em ISO 8601 (ex.: 2026-08-05T09:00:00.000Z). */
  @ApiProperty({ example: '2026-08-05T09:00:00.000Z' })
  @IsString()
  sendAt: string;

  @ApiPropertyOptional({ description: 'ID interno da Message que está sendo respondida' })
  @IsOptional()
  @IsString()
  replyToMessageId?: string;
}
