import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QuickRepliesRepository } from './quick-replies.repository';
import { CreateQuickReplyDto } from './dto/create-quick-reply.dto';
import { UpdateQuickReplyDto } from './dto/update-quick-reply.dto';

/** Normaliza o atalho: sem "/" inicial, sem espaços, minúsculo. */
function normalizeShortcut(raw: string): string {
  return raw.trim().replace(/^\/+/, '').replace(/\s+/g, '-').toLowerCase();
}

@Injectable()
export class QuickRepliesService {
  constructor(private readonly repository: QuickRepliesRepository) {}

  async create(orgId: string, dto: CreateQuickReplyDto) {
    const shortcut = normalizeShortcut(dto.shortcut);
    if (!shortcut) {
      throw new BadRequestException('Informe um atalho válido.');
    }
    const hasContent = !!dto.content?.trim();
    const hasAttachments = !!dto.attachments?.length;
    if (!hasContent && !hasAttachments) {
      throw new BadRequestException(
        'A resposta precisa de um texto ou pelo menos um anexo.',
      );
    }
    const existing = await this.repository.findByShortcut(orgId, shortcut);
    if (existing) {
      throw new ConflictException('Já existe uma resposta com esse atalho.');
    }
    return this.repository.create({
      shortcut,
      title: dto.title,
      content: dto.content ?? '',
      attachments: (dto.attachments ?? []) as unknown as Prisma.InputJsonValue,
      organization: { connect: { id: orgId } },
    });
  }

  async findAll(orgId: string) {
    return this.repository.findByOrg(orgId);
  }

  async findOne(id: string, orgId: string) {
    const row = await this.repository.findById(id);
    if (!row || row.organizationId !== orgId) {
      throw new NotFoundException('Quick reply not found');
    }
    return row;
  }

  async update(id: string, orgId: string, dto: UpdateQuickReplyDto) {
    await this.findOne(id, orgId);
    let shortcut: string | undefined;
    if (dto.shortcut !== undefined) {
      shortcut = normalizeShortcut(dto.shortcut);
      if (!shortcut) throw new BadRequestException('Informe um atalho válido.');
      const clash = await this.repository.findByShortcut(orgId, shortcut);
      if (clash && clash.id !== id) {
        throw new ConflictException('Já existe uma resposta com esse atalho.');
      }
    }
    return this.repository.update(id, {
      ...(shortcut !== undefined && { shortcut }),
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.attachments !== undefined && {
        attachments: dto.attachments as unknown as Prisma.InputJsonValue,
      }),
    });
  }

  async remove(id: string, orgId: string) {
    await this.findOne(id, orgId);
    return this.repository.softDelete(id);
  }
}
