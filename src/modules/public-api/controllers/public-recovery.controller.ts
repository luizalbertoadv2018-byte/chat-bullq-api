import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { PublicActionsService } from '../public-actions.service';

interface MoveStageBody {
  stageKey: string;
  /** Gate de segurança: sem confirm=true, retorna só o preview (dry-run). */
  confirm?: boolean;
}

@ApiTags('Public API · Sales Recovery')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/recovery/conversations')
export class PublicRecoveryController {
  constructor(private readonly actions: PublicActionsService) {}

  @Patch(':conversationId/stage')
  @ApiOperation({
    summary:
      'Move o card de recuperação de uma conversa. Sem confirm=true retorna preview (dry-run); com confirm=true executa.',
  })
  moveStage(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: MoveStageBody,
  ) {
    if (body?.confirm === true) {
      return this.actions.moveRecoveryCard(orgId, conversationId, body.stageKey);
    }
    return this.actions.previewRecoveryMove(orgId, conversationId, body?.stageKey);
  }
}
