import { IsString, IsOptional, IsInt, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSituacaoDto {
  @ApiProperty()
  @IsString()
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ default: '#6B7280' })
  @IsOptional()
  @IsString()
  @Matches(/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/, {
    message: 'color deve ser um hex válido (ex.: #6B7280)',
  })
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  order?: number;
}
