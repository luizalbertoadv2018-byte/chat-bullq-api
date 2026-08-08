import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateTaskDto, UpdateTaskDto, ListTasksQueryDto } from './dto/task.dto';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Dados de contato/responsável embutidos p/ a UI não precisar de N+1. */
  private readonly include: Prisma.TaskInclude = {
    contact: { select: { id: true, name: true, phone: true, avatarUrl: true } },
    assignedTo: { select: { id: true, name: true, avatarUrl: true } },
  };

  async list(orgId: string, query: ListTasksQueryDto) {
    const where: Prisma.TaskWhereInput = {
      organizationId: orgId,
      deletedAt: null,
    };
    if (query.status) where.status = query.status;
    if (query.category) where.category = query.category;
    if (query.assignedToId) where.assignedToId = query.assignedToId;
    // "atrasadas": venceu e ainda não concluiu.
    if (query.overdue === 'true') {
      where.dueAt = { lt: new Date() };
      where.status = { not: TaskStatus.DONE };
    }

    return this.prisma.task.findMany({
      where,
      include: this.include,
      orderBy: [
        { status: 'asc' },
        { dueAt: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
    });
  }

  async findOne(orgId: string, id: string) {
    const task = await this.prisma.task.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: this.include,
    });
    if (!task) throw new NotFoundException('Tarefa não encontrada.');
    return task;
  }

  async create(orgId: string, dto: CreateTaskDto, createdById?: string) {
    return this.prisma.task.create({
      data: {
        organizationId: orgId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.priority ? { priority: dto.priority } : {}),
        category: dto.category?.trim() || null,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        contactId: dto.contactId || null,
        conversationId: dto.conversationId || null,
        assignedToId: dto.assignedToId || null,
        createdById: createdById || null,
        completedAt: dto.status === TaskStatus.DONE ? new Date() : null,
      },
      include: this.include,
    });
  }

  async update(orgId: string, id: string, dto: UpdateTaskDto) {
    await this.findOne(orgId, id);

    const data: Prisma.TaskUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined)
      data.description = dto.description?.trim() || null;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.category !== undefined) data.category = dto.category?.trim() || null;
    if (dto.dueAt !== undefined)
      data.dueAt = dto.dueAt ? new Date(dto.dueAt) : null;
    if (dto.assignedToId !== undefined)
      data.assignedTo = dto.assignedToId
        ? { connect: { id: dto.assignedToId } }
        : { disconnect: true };
    if (dto.contactId !== undefined)
      data.contact = dto.contactId
        ? { connect: { id: dto.contactId } }
        : { disconnect: true };
    if (dto.status !== undefined) {
      data.status = dto.status;
      data.completedAt = dto.status === TaskStatus.DONE ? new Date() : null;
    }

    return this.prisma.task.update({
      where: { id },
      data,
      include: this.include,
    });
  }

  async remove(orgId: string, id: string) {
    await this.findOne(orgId, id);
    await this.prisma.task.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }
}
