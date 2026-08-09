import { Module } from '@nestjs/common';
import { DocumentosBeneficioController } from './documentos-beneficio.controller';
import { DocumentosBeneficioService } from './documentos-beneficio.service';
import { DocumentosBeneficioRepository } from './documentos-beneficio.repository';

@Module({
  controllers: [DocumentosBeneficioController],
  providers: [DocumentosBeneficioService, DocumentosBeneficioRepository],
  exports: [DocumentosBeneficioService],
})
export class DocumentosBeneficioModule {}
