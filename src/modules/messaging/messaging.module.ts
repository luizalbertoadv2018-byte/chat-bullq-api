import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AVATAR_HYDRATION_QUEUE } from '../channel-hub/avatars/avatar-hydration.constants';
import { ChannelHubModule } from '../channel-hub/channel-hub.module';
import { RatingsModule } from '../ratings/ratings.module';
import { AiAgentsModule } from '../ai-agents/ai-agents.module';
import { LlmModule } from '../ai-agents/llm/llm.module';
import { WatchdogModule } from '../routing/watchdog/watchdog.module';
import { SegmentsModule } from '../segments/segments.module';
import { ProjectsModule } from '../projects/projects.module';
import { SalesRecoveryModule } from '../sales-recovery/sales-recovery.module';
import { IdempotencyService } from './pipeline/idempotency.service';
import { ContactResolverService } from './pipeline/contact-resolver.service';
import { ConversationResolverService } from './pipeline/conversation-resolver.service';
import { HistoryImportService } from './pipeline/history-import.service';
import { InboundMessageProcessor } from './pipeline/inbound-message.processor';
import { OutboundMessageProcessor } from './pipeline/outbound-message.processor';
import { ConversationFsmService } from './conversations/conversation-fsm.service';
import { ConversationsController } from './conversations/conversations.controller';
import { ConversationsService } from './conversations/conversations.service';
import { ConversationsRepository } from './conversations/conversations.repository';
import { MessagesController } from './messages/messages.controller';
import { MessagesService } from './messages/messages.service';
import { MessagesRepository } from './messages/messages.repository';
import { TranscriptionService } from './messages/transcription.service';
import { UploadsService } from './messages/uploads.service';
import { MediaResolverService } from './messages/media-resolver.service';
import { DriveService } from './drive/drive.service';
import { DriveSyncProcessor } from './drive/drive-sync.processor';
import { GmailSendService } from './tramitacao/gmail-send.service';
import { TramitacaoService } from './tramitacao/tramitacao.service';
import { TramitacaoSyncProcessor } from './tramitacao/tramitacao-sync.processor';
import { ContactsController } from './contacts/contacts.controller';
import { ContactsService } from './contacts/contacts.service';
import { ContactsRepository } from './contacts/contacts.repository';
import { SCHEDULED_MESSAGES_QUEUE } from './scheduled-messages/scheduled-messages.constants';
import { ScheduledMessagesController } from './scheduled-messages/scheduled-messages.controller';
import { ScheduledMessagesService } from './scheduled-messages/scheduled-messages.service';
import { ScheduledMessagesProcessor } from './scheduled-messages/scheduled-messages.processor';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'inbound-messages' },
      { name: 'outbound-messages' },
      { name: 'chatbot-processor' },
      { name: 'drive-sync' },
      { name: 'tramitacao-sync' },
      { name: SCHEDULED_MESSAGES_QUEUE },
      // Produz aqui (inbox e abertura de conversa); quem consome é o
      // AvatarHydrationProcessor, no ZappfyModule.
      { name: AVATAR_HYDRATION_QUEUE },
    ),
    forwardRef(() => ChannelHubModule),
    RatingsModule,
    AiAgentsModule,
    LlmModule,
    WatchdogModule,
    SegmentsModule,
    ProjectsModule,
    SalesRecoveryModule,
  ],
  controllers: [
    ConversationsController,
    MessagesController,
    ContactsController,
    ScheduledMessagesController,
  ],
  providers: [
    IdempotencyService,
    ContactResolverService,
    ConversationResolverService,
    HistoryImportService,
    InboundMessageProcessor,
    OutboundMessageProcessor,
    ConversationFsmService,
    ConversationsService,
    ConversationsRepository,
    MessagesService,
    MessagesRepository,
    TranscriptionService,
    UploadsService,
    MediaResolverService,
    DriveService,
    DriveSyncProcessor,
    GmailSendService,
    TramitacaoService,
    TramitacaoSyncProcessor,
    ContactsService,
    ContactsRepository,
    ScheduledMessagesService,
    ScheduledMessagesProcessor,
  ],
  exports: [ConversationsService, MessagesService, ConversationFsmService, ContactsService, HistoryImportService, UploadsService],
})
export class MessagingModule {}
