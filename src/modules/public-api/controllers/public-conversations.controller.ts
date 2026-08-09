import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg, CurrentUser } from '../../../common/decorators';
import { PublicActionsService } from '../public-actions.service';

interface ApplyTagsBody {
  tags: string[];
}

interface ReplyBody {
  text: string;
  /** Gate: sem confirm=true retorna preview (dry-run); com true envia. */
  confirm?: boolean;
}

@ApiTags('Public API · Conversations')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/conversations')
export class PublicConversationsController {
  constructor(private readonly actions: PublicActionsService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Lê uma conversa: contato, status, tags e últimas mensagens.',
  })
  read(
    @CurrentOrg('id') orgId: string,
    @Param('id') conversationId: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? parseInt(limit, 10) : 30;
    return this.actions.readConversation(orgId, conversationId, Number.isNaN(n) ? 30 : n);
  }

  @Post(':id/tags')
  @ApiOperation({
    summary: 'Aplica tags a uma conversa (cria as inexistentes; dispara automações).',
  })
  applyTags(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
    @Body() body: ApplyTagsBody,
  ) {
    return this.actions.applyTags(orgId, userId, conversationId, body?.tags ?? []);
  }

  @Post(':id/reply')
  @ApiOperation({
    summary:
      'Responde uma conversa (envia ao cliente). Sem confirm=true retorna preview; com confirm=true envia.',
  })
  reply(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('name') userName: string,
    @Param('id') conversationId: string,
    @Body() body: ReplyBody,
  ) {
    if (body?.confirm === true) {
      return this.actions.replyExecute(orgId, userName, conversationId, body.text);
    }
    return this.actions.replyPreview(orgId, conversationId, body?.text);
  }
}
