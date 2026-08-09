import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { DocumentosBeneficioService } from './documentos-beneficio.service';
import { CreateDocumentoDto, UpdateDocumentoDto } from './dto/documento.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Roles } from '../../common/decorators';

@ApiTags('Documentos por benefício')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('documentos-beneficio')
export class DocumentosBeneficioController {
  constructor(private readonly service: DocumentosBeneficioService) {}

  @Get()
  @ApiOperation({ summary: 'Lista documentos (de um pipeline ou de toda a org)' })
  @ApiQuery({ name: 'pipelineId', required: false })
  findAll(
    @CurrentOrg('id') orgId: string,
    @Query('pipelineId') pipelineId?: string,
  ) {
    return pipelineId
      ? this.service.findByPipeline(orgId, pipelineId)
      : this.service.findAll(orgId);
  }

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Adiciona um documento à lista de um benefício' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: CreateDocumentoDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Atualiza um documento' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateDocumentoDto,
  ) {
    return this.service.update(id, orgId, dto);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Remove um documento da lista' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }
}
