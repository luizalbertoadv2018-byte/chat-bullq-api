import { Module } from '@nestjs/common';
import { EvolutionInboundAdapter } from './evolution.inbound-adapter';
import { EvolutionOutboundAdapter } from './evolution.outbound-adapter';
import { EvolutionMessageMapper } from './evolution.message-mapper';
import { EvolutionHttpClient } from './evolution.http-client';

@Module({
  providers: [
    EvolutionInboundAdapter,
    EvolutionOutboundAdapter,
    EvolutionMessageMapper,
    EvolutionHttpClient,
  ],
  exports: [
    EvolutionInboundAdapter,
    EvolutionOutboundAdapter,
    EvolutionHttpClient,
  ],
})
export class EvolutionModule {}
