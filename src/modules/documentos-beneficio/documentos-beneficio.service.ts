import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { DocumentosBeneficioRepository } from './documentos-beneficio.repository';
import { CreateDocumentoDto, UpdateDocumentoDto } from './dto/documento.dto';

/**
 * Checklist de documentos exigidos por benefício (pipeline). A IA usa via
 * ChecklistDocumentosTool pra cobrar o que falta; o operador gerencia as listas
 * em Configurações → Documentos.
 */
@Injectable()
export class DocumentosBeneficioService {
  constructor(private readonly repository: DocumentosBeneficioRepository) {}

  async create(orgId: string, dto: CreateDocumentoDto) {
    const existing = await this.repository.findByPipeline(orgId, dto.pipelineId);
    const dup = existing.find(
      (d) => d.name.toLowerCase() === dto.name.trim().toLowerCase(),
    );
    if (dup) {
      throw new ConflictException('Esse documento já está na lista deste benefício');
    }
    const order = dto.order ?? existing.length;
    return this.repository.create({
      name: dto.name.trim(),
      order,
      organization: { connect: { id: orgId } },
      pipeline: { connect: { id: dto.pipelineId } },
    });
  }

  findByPipeline(orgId: string, pipelineId: string) {
    return this.repository.findByPipeline(orgId, pipelineId);
  }

  findAll(orgId: string) {
    return this.repository.findByOrg(orgId);
  }

  async findOne(id: string, orgId: string) {
    const doc = await this.repository.findById(id);
    if (!doc || doc.organizationId !== orgId) {
      throw new NotFoundException('Documento não encontrado');
    }
    return doc;
  }

  async update(id: string, orgId: string, dto: UpdateDocumentoDto) {
    await this.findOne(id, orgId);
    return this.repository.update(id, {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.order !== undefined && { order: dto.order }),
    });
  }

  async remove(id: string, orgId: string) {
    await this.findOne(id, orgId);
    return this.repository.delete(id);
  }
}
