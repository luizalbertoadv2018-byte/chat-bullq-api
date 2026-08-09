import { PartialType } from '@nestjs/swagger';
import { CreateSituacaoDto } from './create-situacao.dto';

export class UpdateSituacaoDto extends PartialType(CreateSituacaoDto) {}
