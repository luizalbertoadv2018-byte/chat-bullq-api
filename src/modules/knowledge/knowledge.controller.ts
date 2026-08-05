import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { KnowledgeService } from './knowledge.service';
import { CreateKnowledgeDto, UpdateKnowledgeDto } from './dto/create-knowledge.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Roles } from '../../common/decorators';

// 32MB: guias/PDFs de escritório são pequenos; acima disso provável abuso.
const MAX_PDF_BYTES = 32 * 1024 * 1024;

@ApiTags('Knowledge base')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('knowledge/documents')
export class KnowledgeController {
  constructor(private readonly service: KnowledgeService) {}

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Cria documento a partir de texto colado' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: CreateKnowledgeDto) {
    return this.service.create(orgId, dto, { sourceType: 'TEXT' });
  }

  @Post('upload')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PDF_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Cria documento a partir de PDF (extrai o texto)' })
  async upload(
    @CurrentOrg('id') orgId: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; originalname?: string } | undefined,
    @Body() body: { title?: string; agentIds?: string },
  ) {
    if (!file) throw new BadRequestException('Envie um arquivo PDF no campo "file".');
    if (file.mimetype !== 'application/pdf' && !file.originalname?.toLowerCase().endsWith('.pdf')) {
      throw new BadRequestException('Só aceito arquivos PDF por enquanto.');
    }
    // agentIds vem como string no multipart (JSON array ou lista separada por vírgula).
    let agentIds: string[] = [];
    const raw = (body.agentIds ?? '').trim();
    if (raw.startsWith('[')) {
      try {
        agentIds = JSON.parse(raw);
      } catch {
        throw new BadRequestException('agentIds inválido.');
      }
    } else if (raw) {
      agentIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!agentIds.length) {
      throw new BadRequestException('Selecione pelo menos um agente.');
    }

    const text = await this.service.extractPdfText(file.buffer);
    if (!text) {
      throw new BadRequestException('O PDF não tem texto extraível (pode ser escaneado).');
    }
    const title =
      (body.title ?? '').trim() ||
      (file.originalname ?? 'Documento').replace(/\.pdf$/i, '');

    return this.service.create(
      orgId,
      { title, content: text, agentIds },
      { sourceType: 'PDF', fileName: file.originalname },
    );
  }

  @Get()
  @ApiOperation({ summary: 'Lista documentos da base' })
  findAll(@CurrentOrg('id') orgId: string) {
    return this.service.findAll(orgId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um documento' })
  findOne(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.findOne(id, orgId);
  }

  @Patch(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Atualiza documento (reindexação automática)' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateKnowledgeDto,
  ) {
    return this.service.update(id, orgId, dto);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Remove documento e seus vetores' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }
}
