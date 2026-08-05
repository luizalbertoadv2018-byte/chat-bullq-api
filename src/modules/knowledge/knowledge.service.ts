import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateKnowledgeDto, UpdateKnowledgeDto } from './dto/create-knowledge.dto';

// pdf-parse é CommonJS sem tipos — require devolve a função de extração.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = require('pdf-parse');

/** Um trecho recuperado da base pra injetar no prompt do agente. */
export interface KnowledgeHit {
  title: string;
  content: string;
  rank: number;
}

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

  /** Nº de "trechos" só pra exibição (busca é full-text sobre o doc inteiro). */
  private sectionCount(content: string): number {
    const paras = content.split(/\n\n+/).filter((p) => p.trim().length > 0);
    return Math.max(1, paras.length);
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
   * Recupera trechos da base relevantes p/ a mensagem, escopados ao agente.
   *
   * Busca por sobreposição de termos em JS (accent- e case-insensitive),
   * sem depender de embeddings/pgvector nem de extensões do Postgres. Para
   * uma base curada de guias/FAQ (poucos documentos) isso é preciso e barato:
   * carrega os docs do agente e pontua por frequência dos termos da pergunta,
   * com peso extra pra casamento no título. Retorna [] se nada casar.
   */
  async retrieveForAgent(
    agentId: string,
    query: string,
    limit = 3,
  ): Promise<KnowledgeHit[]> {
    const terms = tokenize(query);
    if (!terms.length) return [];

    const docs = await this.prisma.knowledgeDocument.findMany({
      where: { deletedAt: null, agents: { some: { agentId } } },
      select: { title: true, content: true },
    });
    if (!docs.length) return [];

    const scored = docs
      .map((d) => {
        const titleN = normalizeForSearch(d.title);
        const bodyN = normalizeForSearch(d.content);
        let score = 0;
        let matched = 0;
        for (const t of terms) {
          const inTitle = countOccurrences(titleN, t);
          const inBody = countOccurrences(bodyN, t);
          if (inTitle + inBody > 0) matched++;
          score += inTitle * 5 + inBody;
        }
        // Exige casar ao menos 1 termo "de conteúdo" pra evitar ruído.
        return { title: d.title, content: d.content, rank: score, matched };
      })
      .filter((d) => d.matched > 0 && d.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit);

    return scored.map(({ title, content, rank }) => ({ title, content, rank }));
  }
}

// ─── helpers de busca (accent- e case-insensitive) ───────────────────

const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'e', 'ou',
  'que', 'com', 'sem', 'por', 'para', 'pra', 'no', 'na', 'nos', 'nas', 'em',
  'ao', 'aos', 'me', 'te', 'se', 'eu', 'voce', 'vc', 'ele', 'ela', 'meu',
  'minha', 'seu', 'sua', 'como', 'qual', 'quais', 'quanto', 'quanta', 'quando',
  'onde', 'e', 'ja', 'nao', 'sim', 'isso', 'esse', 'essa', 'este', 'esta',
  'sobre', 'the', 'of', 'to',
]);

/** minúsculas + sem acento, colapsa espaços. */
function normalizeForSearch(text: string): string {
  return (text || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Termos significativos da pergunta (normalizados, sem stopwords/curtos). */
function tokenize(query: string): string[] {
  const norm = normalizeForSearch(query);
  const raw = norm.split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** Conta ocorrências de `term` (por palavra) no texto já normalizado. */
function countOccurrences(haystackNorm: string, term: string): number {
  if (!term) return 0;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'g');
  let n = 0;
  while (re.exec(haystackNorm) !== null) n++;
  return n;
}
