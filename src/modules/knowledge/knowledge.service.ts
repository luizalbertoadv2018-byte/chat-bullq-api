import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateKnowledgeDto, UpdateKnowledgeDto } from './dto/create-knowledge.dto';
import {
  KnowledgeHit,
  rankKnowledgeChunks,
  splitIntoChunks,
} from './knowledge-search.util';

// pdf-parse é CommonJS sem tipos — require devolve a função de extração.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = require('pdf-parse');

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Extrai texto de um PDF (buffer do upload). */
  async extractPdfText(buffer: Buffer): Promise<string> {
    try {
      const data = await pdfParse(buffer);
      return (data.text ?? '').trim();
    } catch (err) {
      this.logger.error(`pdf_parse_failed: ${(err as Error).message}`);
      throw new BadRequestException(
        'Não consegui ler o texto desse PDF. Ele pode ser uma imagem escaneada (sem texto).',
      );
    }
  }

  private async assertAgents(orgId: string, agentIds: string[]): Promise<void> {
    const unique = [...new Set(agentIds)];
    const count = await this.prisma.aiAgent.count({
      where: { id: { in: unique }, organizationId: orgId, deletedAt: null },
    });
    if (count !== unique.length) {
      throw new BadRequestException(
        'Um ou mais agentes informados não existem nesta organização.',
      );
    }
  }

  /** Nº de trechos em que a busca divide o documento (exibido na tela). */
  private sectionCount(content: string): number {
    return Math.max(1, splitIntoChunks(content).length);
  }

  async create(
    orgId: string,
    dto: CreateKnowledgeDto,
    opts?: { sourceType?: 'TEXT' | 'PDF'; fileName?: string },
  ) {
    const content = (dto.content ?? '').trim();
    if (!content) throw new BadRequestException('O documento está vazio.');
    await this.assertAgents(orgId, dto.agentIds);

    return this.prisma.knowledgeDocument.create({
      data: {
        organizationId: orgId,
        title: dto.title.trim(),
        content,
        sourceType: opts?.sourceType ?? 'TEXT',
        fileName: opts?.fileName ?? null,
        // Busca é full-text nativa do Postgres — pronto na hora, sem indexação externa.
        status: 'READY',
        chunkCount: this.sectionCount(content),
        agents: {
          create: [...new Set(dto.agentIds)].map((agentId) => ({ agentId })),
        },
      },
      include: { agents: { include: { agent: { select: { id: true, name: true } } } } },
    });
  }

  async findAll(orgId: string) {
    return this.prisma.knowledgeDocument.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: { agents: { include: { agent: { select: { id: true, name: true } } } } },
    });
  }

  async findOne(id: string, orgId: string) {
    const doc = await this.prisma.knowledgeDocument.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: { agents: { include: { agent: { select: { id: true, name: true } } } } },
    });
    if (!doc) throw new NotFoundException('Documento não encontrado.');
    return doc;
  }

  async update(id: string, orgId: string, dto: UpdateKnowledgeDto) {
    await this.findOne(id, orgId);
    if (dto.agentIds !== undefined) await this.assertAgents(orgId, dto.agentIds);
    const content = dto.content !== undefined ? (dto.content ?? '').trim() : undefined;

    await this.prisma.knowledgeDocument.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title.trim() }),
        ...(content !== undefined && {
          content,
          chunkCount: this.sectionCount(content),
          status: 'READY',
        }),
        ...(dto.agentIds !== undefined && {
          agents: {
            deleteMany: {},
            create: [...new Set(dto.agentIds)].map((agentId) => ({ agentId })),
          },
        }),
      },
    });
    return this.findOne(id, orgId);
  }

  async remove(id: string, orgId: string) {
    await this.findOne(id, orgId);
    await this.prisma.knowledgeDocument.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Recupera os trechos da base mais relevantes p/ a mensagem, escopados ao
   * agente. Busca por sobreposição de termos em JS (accent- e
   * case-insensitive), sem embeddings/pgvector. Cada documento é dividido em
   * trechos e só os melhores trechos voltam (ver knowledge-search.util.ts),
   * então a resposta no meio de um guia longo também chega à IA.
   */
  async retrieveForAgent(
    agentId: string,
    query: string,
    limit = 4,
  ): Promise<KnowledgeHit[]> {
    if (!query?.trim()) return [];
    const docs = await this.prisma.knowledgeDocument.findMany({
      where: { deletedAt: null, agents: { some: { agentId } } },
      select: { title: true, content: true },
    });
    return rankKnowledgeChunks(docs, query, limit);
  }
}
