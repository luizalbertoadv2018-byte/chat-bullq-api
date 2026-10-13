import { Body, Controller, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Roles } from '../../common/decorators';
import { FollowUpService } from './follow-up.service';
import { FollowUpSummaryService } from './follow-up-summary.service';

@ApiTags('Follow-up')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('follow-up')
export class FollowUpController {
  constructor(
    private readonly followUp: FollowUpService,
    private readonly summary: FollowUpSummaryService,
  ) {}

  @Patch('conversations/:id')
  @ApiOperation({ summary: 'Pausa ou retoma o follow-up automático de uma conversa' })
  async setPaused(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() body: { paused: boolean },
  ) {
    return this.followUp.setPaused(id, orgId, !!body?.paused);
  }

  @Post('backfill')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({
    summary: 'Põe na fila de follow-up os leads que já estavam parados (leva limitada)',
  })
  async backfill(
    @CurrentOrg('id') orgId: string,
    @Body() body: { limit?: number; force?: boolean },
  ) {
    return this.followUp.backfill({
      organizationId: orgId,
      limit: body?.limit,
      force: body?.force,
    });
  }

  @Post('summary/run')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Envia agora o resumo diário para o grupo de avisos' })
  async runSummary(@CurrentOrg('id') orgId: string) {
    return { sent: await this.summary.sendFor(orgId) };
  }
}
