import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Channel, OrgRole } from '@prisma/client';
import { ChannelsService } from '../../channels/channels.service';
import { EvolutionHttpClient } from './evolution.http-client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../../common/guards';
import {
  CurrentOrg,
  CurrentChannelAccess,
  Roles,
} from '../../../../common/decorators';
import type { ChannelAccess } from '../../../iam/channel-access/channel-access.service';

/**
 * Conexão por QR Code de um canal Evolution já criado (POST /channels normal
 * com type=WHATSAPP_EVOLUTION e config={baseUrl,apiKey,instance}).
 * `connect` garante a instância no Evolution (apontando o webhook pro BullQ) e
 * devolve o QR Code pra parear o WhatsApp.
 */
@ApiTags('Channels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('channels')
export class EvolutionConnectController {
  private readonly logger = new Logger(EvolutionConnectController.name);
  private readonly appUrl: string;

  constructor(
    private readonly channels: ChannelsService,
    private readonly evo: EvolutionHttpClient,
    config: ConfigService,
  ) {
    this.appUrl = (
      config.get<string>('APP_URL') || 'http://localhost:3001'
    ).replace(/\/$/, '');
  }

  @Post(':id/evolution/connect')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Cria/pareia a instância Evolution e devolve o QR Code' })
  async connect(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    const channel = (await this.channels.findOne(id, orgId, access)) as Channel;
    const webhookUrl = `${this.appUrl}/api/v1/webhooks/WHATSAPP_EVOLUTION`;

    // Cria a instância (idempotente — se já existe, o Evolution recusa e a
    // gente segue direto pro connect).
    try {
      await this.evo.createInstanceForChannel(channel, webhookUrl);
    } catch (err: any) {
      this.logger.warn(
        `createInstance (provavelmente já existe): ${err?.response?.data?.message || err.message}`,
      );
    }

    const qr = await this.evo.connect(channel);
    return {
      ...qr,
      webhookUrl,
      aviso:
        'A instância Evolution precisa alcançar esta URL de webhook publicamente (localhost não recebe — use um túnel/deploy).',
    };
  }

  @Get(':id/evolution/status')
  @ApiOperation({ summary: 'Estado da conexão da instância Evolution' })
  async status(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    const channel = (await this.channels.findOne(id, orgId, access)) as Channel;
    return { state: await this.evo.getConnectionState(channel) };
  }
}
