import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg, CurrentUser } from '../../../common/decorators';
import { PublicActionsService } from '../public-actions.service';

interface BroadcastBody {
  filter: { tag?: string; conversationIds?: string[] };
  text: string;
  /** Gate: sem confirm=true retorna preview (contagem + amostra); com true dispara. */
  confirm?: boolean;
}

@ApiTags('Public API · Broadcasts')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/broadcasts')
export class PublicBroadcastsController {
  constructor(private readonly actions: PublicActionsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Disparo em massa para conversas selecionadas por tag ou lista de IDs. Sem confirm=true retorna preview (quantos + amostra); com confirm=true dispara.',
  })
  send(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('name') userName: string,
    @Body() body: BroadcastBody,
  ) {
    if (body?.confirm === true) {
      return this.actions.broadcastExecute(orgId, userName, body.filter, body.text);
    }
    return this.actions.broadcastPreview(orgId, body?.filter, body?.text);
  }
}
