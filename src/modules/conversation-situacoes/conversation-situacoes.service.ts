import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ConversationSituacoesRepository } from './conversation-situacoes.repository';
import { CreateSituacaoDto } from './dto/create-situacao.dto';
import { UpdateSituacaoDto } from './dto/update-situacao.dto';

const DEFAULT_COLOR = '#6B7280';

/**
 * CRUD das "Situações" — rótulos de negócio configuráveis por organização
 * (Contrato Assinado, Qualificado, ...). Não tocam no `status` do sistema.
 */
@Injectable()
export class ConversationSituacoesService {
  constructor(private readonly repository: ConversationSituacoesRepository) {}

  async create(orgId: string, dto: CreateSituacaoDto) {
    const existing = await this.repository.findByOrg(orgId);
    const dup = existing.find(
      (s) => s.name.toLowerCase() === dto.name.trim().toLowerCase(),
    );
    if (dup) {
      throw new ConflictException('Já existe uma situação com esse nome');
    }
    // Nova situação vai pro fim da lista por padrão.
    const order = dto.order ?? existing.length;
    return this.repository.create({
      name: dto.name.trim(),
      color: dto.color ?? DEFAULT_COLOR,
      order,
      organization: { connect: { id: orgId } },
    });
  }

  async findAll(orgId: string) {
    return this.repository.findByOrg(orgId);
  }

  async findOne(id: string, orgId: string) {
    const situacao = await this.repository.findById(id);
    if (!situacao || situacao.organizationId !== orgId) {
      throw new NotFoundException('Situação não encontrada');
    }
    return situacao;
  }

  async update(id: string, orgId: string, dto: UpdateSituacaoDto) {
    await this.findOne(id, orgId);
    if (dto.name !== undefined) {
      const all = await this.repository.findByOrg(orgId);
      const dup = all.find(
        (s) =>
          s.id !== id &&
          s.name.toLowerCase() === dto.name!.trim().toLowerCase(),
      );
      if (dup) {
        throw new ConflictException('Já existe uma situação com esse nome');
      }
    }
    return this.repository.update(id, {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.color !== undefined && { color: dto.color }),
      ...(dto.order !== undefined && { order: dto.order }),
    });
  }

  async remove(id: string, orgId: string) {
    await this.findOne(id, orgId);
    // O onDelete: SetNull no schema zera a situação das conversas que a usavam.
    return this.repository.delete(id);
  }
}
