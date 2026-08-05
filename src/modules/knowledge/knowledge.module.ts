import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

/**
 * Base de conhecimento por agente. Documento (texto ou PDF) fica escrito na
 * tabela `knowledge_documents`, vinculado a agentes. O agente recupera os
 * trechos relevantes no run via full-text search nativa do Postgres
 * (config 'portuguese') — sem embeddings/pgvector, funciona sem infra extra.
 */
@Module({
  imports: [PrismaModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
