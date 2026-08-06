import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class TestMessageDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;
}

export class TestAgentDto {
  @ApiProperty({ type: [TestMessageDto], description: 'Histórico da conversa de teste (user/assistant).' })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TestMessageDto)
  messages!: TestMessageDto[];

  @ApiPropertyOptional({
    description:
      'Prompt a testar. Se enviado, sobrepõe o systemPrompt salvo — permite testar edições ainda NÃO salvas no editor.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30000)
  systemPrompt?: string;
}
