import { Module } from '@nestjs/common';
import { ConversationSituacoesController } from './conversation-situacoes.controller';
import { ConversationSituacoesService } from './conversation-situacoes.service';
import { ConversationSituacoesRepository } from './conversation-situacoes.repository';

@Module({
  controllers: [ConversationSituacoesController],
  providers: [ConversationSituacoesService, ConversationSituacoesRepository],
  exports: [ConversationSituacoesService],
})
export class ConversationSituacoesModule {}
