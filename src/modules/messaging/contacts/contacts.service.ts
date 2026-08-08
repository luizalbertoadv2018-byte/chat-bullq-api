import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ContactsRepository } from './contacts.repository';
import { UpdateContactDto } from './dto/update-contact.dto';
import { TramitacaoService } from '../tramitacao/tramitacao.service';
import { isValidCpf, onlyDigits } from '../../../common/util/cpf.util';

@Injectable()
export class ContactsService {
  constructor(
    private readonly repository: ContactsRepository,
    private readonly tramitacao: TramitacaoService,
    @InjectQueue('tramitacao-sync') private readonly tramitacaoQueue: Queue,
  ) {}

  async findAll(organizationId: string, search: string | undefined, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const { contacts, total } = await this.repository.findByOrg(organizationId, search, skip, limit);
    return {
      contacts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, organizationId: string) {
    const contact = await this.repository.findById(id);
    if (!contact) throw new NotFoundException('Contact not found');
    if (contact.organizationId !== organizationId) throw new ForbiddenException();
    return contact;
  }

  async update(id: string, organizationId: string, dto: UpdateContactDto) {
    const existing = await this.findOne(id, organizationId);
    const data: UpdateContactDto = { ...dto };
    // metadata é JSON — mesclar com o existente pra não apagar outras chaves
    // (ex: origem gravada aqui não deve zerar enriquecimento do provider).
    if (dto.metadata) {
      const current = (existing.metadata as Record<string, any>) ?? {};
      data.metadata = { ...current, ...dto.metadata };
    }

    // CPF: aceita formatado, guarda só os dígitos e valida (recusa número
    // que não é CPF). String vazia limpa o campo.
    let cpfChanged = false;
    if (dto.cpf !== undefined) {
      const digits = onlyDigits(dto.cpf);
      if (digits === '') {
        data.cpf = null as any;
      } else if (isValidCpf(digits)) {
        data.cpf = digits;
        cpfChanged = onlyDigits(existing.cpf) !== digits;
      } else {
        throw new BadRequestException('CPF inválido.');
      }
    }

    const updated = await this.repository.update(id, data);

    // CPF novo definido à mão → casa com o cliente do Tramitação (Camada 1).
    if (cpfChanged && data.cpf && this.tramitacao.isEnabled()) {
      await this.tramitacaoQueue
        .add(
          'sync',
          { kind: 'cpf', contactId: id, organizationId },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 8000 },
            removeOnComplete: true,
            removeOnFail: 50,
          },
        )
        .catch(() => undefined);
    }

    return updated;
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    return this.repository.softDelete(id);
  }

  async setBlocked(id: string, organizationId: string, blocked: boolean) {
    await this.findOne(id, organizationId);
    return this.repository.setBlocked(id, blocked);
  }
}
