import { Module, forwardRef } from '@nestjs/common';
import { EvolutionInboundAdapter } from './evolution.inbound-adapter';
import { EvolutionOutboundAdapter } from './evolution.outbound-adapter';
import { EvolutionMessageMapper } from './evolution.message-mapper';
import { EvolutionHttpClient } from './evolution.http-client';
import { EvolutionContactEnricherService } from './evolution-contact-enricher.service';
import { MessagingModule } from '../../../messaging/messaging.module';

@Module({
  imports: [
    // O enricher re-hospeda a foto de perfil pelo UploadsService, que vive no
    // MessagingModule (mesmo forwardRef do Zappfy).
    forwardRef(() => MessagingModule),
  ],
  providers: [
    EvolutionInboundAdapter,
    EvolutionOutboundAdapter,
    EvolutionMessageMapper,
    EvolutionHttpClient,
    EvolutionContactEnricherService,
  ],
  exports: [
    EvolutionInboundAdapter,
    EvolutionOutboundAdapter,
    EvolutionHttpClient,
    EvolutionContactEnricherService,
  ],
})
export class EvolutionModule {}
