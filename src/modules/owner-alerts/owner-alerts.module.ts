import { Global, Module } from '@nestjs/common';
import { OwnerAlertService } from './owner-alert.service';

/** Global: avisos são disparados de pontos bem diferentes (IA, assinatura). */
@Global()
@Module({
  providers: [OwnerAlertService],
  exports: [OwnerAlertService],
})
export class OwnerAlertsModule {}
