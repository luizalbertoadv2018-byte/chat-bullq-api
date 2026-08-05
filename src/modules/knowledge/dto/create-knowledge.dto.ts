import {
  IsString,
  IsOptional,
  IsArray,
  ArrayNotEmpty,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateKnowledgeDto {
  @ApiProperty({ description: 'Título do documento (ex.: "Guia Auxílio-Acidente")' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiProperty({ description: 'Texto integral do documento (colado)' })
  @IsString()
  @MaxLength(200_000)
  content: string;

  @ApiProperty({
    description: 'IDs dos agentes que terão acesso a este documento',
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  agentIds: string[];
}

export class UpdateKnowledgeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  content?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  agentIds?: string[];
}
