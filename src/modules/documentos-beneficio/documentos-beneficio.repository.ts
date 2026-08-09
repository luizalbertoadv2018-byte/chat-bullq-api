import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class DocumentosBeneficioRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.DocumentoBeneficioCreateInput) {
    return this.prisma.documentoBeneficio.create({ data });
  }

  findByPipeline(organizationId: string, pipelineId: string) {
    return this.prisma.documentoBeneficio.findMany({
      where: { organizationId, pipelineId },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });
  }

  findByOrg(organizationId: string) {
    return this.prisma.documentoBeneficio.findMany({
      where: { organizationId },
      orderBy: [{ pipelineId: 'asc' }, { order: 'asc' }],
    });
  }

  findById(id: string) {
    return this.prisma.documentoBeneficio.findUnique({ where: { id } });
  }

  countByPipeline(organizationId: string, pipelineId: string) {
    return this.prisma.documentoBeneficio.count({
      where: { organizationId, pipelineId },
    });
  }

  update(id: string, data: Prisma.DocumentoBeneficioUpdateInput) {
    return this.prisma.documentoBeneficio.update({ where: { id }, data });
  }

  delete(id: string) {
    return this.prisma.documentoBeneficio.delete({ where: { id } });
  }
}
