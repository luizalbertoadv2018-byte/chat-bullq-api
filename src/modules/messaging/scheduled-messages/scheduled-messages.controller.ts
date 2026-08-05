import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { ScheduledMessagesService } from './scheduled-messages.service';
import { CreateScheduledMessageDto } from './dto/create-scheduled-message.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import {
  CurrentUser,
  CurrentOrg,
  CurrentChannelAccess,
} from '../../../common/decorators';
import type { ChannelAccess } from '../../iam/channel-access/channel-access.service';

@ApiTags('Scheduled Messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('scheduled-messages')
export class ScheduledMessagesController {
  constructor(private readonly service: ScheduledMessagesService) {}

  @Post()
  @ApiOperation({ summary: 'Agenda uma mensagem para envio futuro' })
  create(
    @Body() dto: CreateScheduledMessageDto,
    @CurrentUser('id') userId: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.schedule(dto, userId, orgId, access);
  }

  @Get()
  @ApiOperation({ summary: 'Lista os agendamentos pendentes' })
  list(@CurrentOrg('id') orgId: string) {
    return this.service.list(orgId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancela um agendamento pendente' })
  cancel(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.cancel(id, orgId);
  }
}
