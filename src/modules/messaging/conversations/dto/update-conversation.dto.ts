import { IsOptional, IsString, IsEnum, MaxLength, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationStatus } from '@prisma/client';

export class UpdateConversationDto {
  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignedToId?: string;

  // Aceita string (id do departamento) ou null (limpar). O front manda
  // `departmentId` — NÃO `department` (esse era o bug do 400).
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  departmentId?: string | null;

  // Situação de negócio (rótulo configurável). string = setar, null = limpar.
  // NÃO passa pela FSM — é um campo simples, ortogonal ao `status`.
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  situacaoId?: string | null;

  /** Apelido interno da conversa — só nós vemos, o cliente não. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subject?: string;
}
