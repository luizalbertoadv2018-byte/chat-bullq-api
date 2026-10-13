import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Etiqueta de etapa: a conversa carrega UMA só, a da etapa atual do funil,
 * aplicada pelo sistema quando o card muda de coluna. Antes a IA colava uma
 * etiqueta a cada etapa e nada tirava a anterior — a lista ficava com
 * "recepção, analisando proposta, proposta aceita, assinatura pendente..."
 * todas ao mesmo tempo.
 */

/** Compara nomes ignorando maiúsculas, acentos, hífens e espaços extras. */
export function normalizeTagName(value: string): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Nomes que indicam etapa do atendimento (já normalizados). Inclui os que a
// IA usava e os das situações; os nomes das situações da organização entram
// também, em tempo de execução.
const STAGE_TAG_KEYS = new Set([
  'recepcao',
  'lead novo',
  'analise',
  'em analise',
  'analisando proposta',
  'proposta enviada',
  'proposta aceita',
  'qualificado',
  'assinatura pendente',
  'ficha enviada',
  'contrato assinado',
  'aguardando documentos',
  'desqualificado',
  'sem retorno',
]);

export function isStageTagName(name: string): boolean {
  return STAGE_TAG_KEYS.has(normalizeTagName(name));
}

type Db = Pick<PrismaClient, 'tag' | 'conversationTag' | 'conversationSituacao'>;

/**
 * Deixa na conversa apenas a etiqueta da etapa atual (`stageName`), tirando
 * as outras etiquetas de etapa. Reaproveita a etiqueta existente com o mesmo
 * nome (mesmo escrito com hífen ou sem acento) em vez de criar outra.
 */
export async function applyStageTag(
  db: Db,
  organizationId: string,
  conversationId: string,
  stageName: string,
): Promise<void> {
  const wanted = normalizeTagName(stageName);
  if (!wanted) return;

  const [tags, situacoes] = await Promise.all([
    db.tag.findMany({
      where: { organizationId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.conversationSituacao.findMany({
      where: { organizationId },
      select: { name: true },
    }),
  ]);
  const stageKeys = new Set([
    ...STAGE_TAG_KEYS,
    ...situacoes.map((s) => normalizeTagName(s.name)),
    wanted,
  ]);

  const canonical = stageName.trim().toLowerCase();
  let target: { id: string; name: string } | undefined =
    tags.find((t) => t.name === canonical) ??
    tags.find((t) => normalizeTagName(t.name) === wanted);
  if (!target) {
    target = await db.tag.create({
      data: { organizationId, name: canonical },
      select: { id: true, name: true },
    });
  }

  const targetId = target.id;
  const otherStageTagIds = tags
    .filter((t) => t.id !== targetId && stageKeys.has(normalizeTagName(t.name)))
    .map((t) => t.id);
  if (otherStageTagIds.length > 0) {
    await db.conversationTag.deleteMany({
      where: { conversationId, tagId: { in: otherStageTagIds } },
    });
  }

  try {
    await db.conversationTag.create({
      data: { conversationId, tagId: targetId },
    });
  } catch (err) {
    // Já estava com a etiqueta certa.
    if (
      !(err instanceof Prisma.PrismaClientKnownRequestError) ||
      err.code !== 'P2002'
    ) {
      throw err;
    }
  }
}
