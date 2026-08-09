import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PublicMeController } from './controllers/public-me.controller';
import { PublicDashboardController } from './controllers/public-dashboard.controller';
import { PublicConversationsController } from './controllers/public-conversations.controller';
import { PublicRecoveryController } from './controllers/public-recovery.controller';
import { PublicBroadcastsController } from './controllers/public-broadcasts.controller';
import { PublicActionsService } from './public-actions.service';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AuthModule } from '../auth/auth.module';
import { SalesRecoveryModule } from '../sales-recovery/sales-recovery.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    AuthModule,
    DashboardModule,
    SalesRecoveryModule,
    RealtimeModule,
    BullModule.registerQueue({ name: 'outbound-messages' }),
  ],
  controllers: [
    PublicMeController,
    PublicDashboardController,
    PublicConversationsController,
    PublicRecoveryController,
    PublicBroadcastsController,
  ],
  providers: [PublicActionsService],
})
export class PublicApiModule {}
