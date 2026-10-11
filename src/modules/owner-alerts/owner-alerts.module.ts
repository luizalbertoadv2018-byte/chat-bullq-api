import { Global, Module } from '@nestjs/common';
import { OwnerAlertService } from './owner-alert.service';
import { ClientGroupService } from './client-group.service';

/** Global: avisos são disparados de pontos bem diferentes (IA, assinatura). */
@Global()
@Module({
  providers: [OwnerAlertService, ClientGroupService],
  exports: [OwnerAlertService, ClientGroupService],
})
export class OwnerAlertsModule {}
