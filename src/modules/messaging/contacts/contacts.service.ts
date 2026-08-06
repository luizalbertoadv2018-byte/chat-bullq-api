import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ContactsRepository } from './contacts.repository';
import { UpdateContactDto } from './dto/update-contact.dto';

@Injectable()
export class ContactsService {
  constructor(private readonly repository: ContactsRepository) {}

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
    return this.repository.update(id, data);
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
