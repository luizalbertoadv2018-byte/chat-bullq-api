import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReactMessageDto {
  @ApiProperty({
    example: '👍',
    description: 'Emoji da reação. String vazia remove a reação já enviada.',
  })
  @IsString()
  @MaxLength(16)
  emoji: string;
}
