import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class ConversationSituacoesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.ConversationSituacaoCreateInput) {
    return this.prisma.conversationSituacao.create({ data });
  }

  async findByOrg(organizationId: string) {
    return this.prisma.conversationSituacao.findMany({
      where: { organizationId },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });
  }

  async findById(id: string) {
    return this.prisma.conversationSituacao.findUnique({ where: { id } });
  }

  async countByOrg(organizationId: string) {
    return this.prisma.conversationSituacao.count({ where: { organizationId } });
  }

  async update(id: string, data: Prisma.ConversationSituacaoUpdateInput) {
    return this.prisma.conversationSituacao.update({ where: { id }, data });
  }

  async delete(id: string) {
    return this.prisma.conversationSituacao.delete({ where: { id } });
  }
}
