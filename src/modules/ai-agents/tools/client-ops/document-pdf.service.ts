import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import PDFDocument from 'pdfkit';

export interface GenerateDocInput {
  /** Título/cabeçalho do documento (ex.: "Contrato de Honorários"). */
  title: string;
  /** Corpo do documento. Parágrafos separados por linha em branco (\n\n). */
  body: string;
  /** Subtítulo opcional abaixo do título (ex.: nome do escritório). */
  subtitle?: string;
}

export interface GeneratedDoc {
  /** PDF em memória — usado p/ enviar em base64 pra ZapSign. */
  buffer: Buffer;
  /** base64 puro (sem prefixo data:) do PDF. */
  base64: string;
  /** Caminho local salvo (registro do escritório). */
  filePath: string;
  /** URL pública servida pela API (/api/v1/uploads/...). */
  localUrl: string;
}

/**
 * Gera PDFs simples de documentos jurídicos (procuração, contrato de
 * honorários, declaração) a partir de texto. Usa pdfkit (100% JS, sem
 * browser) — roda no servidor sem dependência externa. O PDF é devolvido
 * em memória (p/ mandar em base64 pra ZapSign, contornando a exigência de
 * URL pública) e também salvo em UPLOADS_DIR como registro do escritório.
 */
@Injectable()
export class DocumentPdfService {
  private readonly logger = new Logger(DocumentPdfService.name);
  private readonly uploadsDir: string;
  private readonly appUrl: string;

  constructor(config: ConfigService) {
    this.uploadsDir = path.resolve(
      config.get<string>('UPLOADS_DIR') || path.join(process.cwd(), 'uploads'),
    );
    this.appUrl = (
      config.get<string>('APP_URL') || 'http://localhost:3001'
    ).replace(/\/$/, '');
  }

  async generate(input: GenerateDocInput): Promise<GeneratedDoc> {
    const buffer = await this.renderPdf(input);
    const base64 = buffer.toString('base64');

    const dir = path.join(this.uploadsDir, 'signatures');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fileName = `${randomUUID()}.pdf`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, buffer);

    const localUrl = `${this.appUrl}/api/v1/uploads/signatures/${fileName}`;
    this.logger.log(`PDF gerado: ${fileName} (${buffer.length} bytes)`);

    return { buffer, base64, filePath, localUrl };
  }

  private renderPdf(input: GenerateDocInput): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margins: { top: 64, bottom: 64, left: 64, right: 64 },
          info: { Title: input.title },
        });

        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc
          .font('Helvetica-Bold')
          .fontSize(16)
          .text(input.title.toUpperCase(), { align: 'center' });

        if (input.subtitle) {
          doc
            .moveDown(0.3)
            .font('Helvetica')
            .fontSize(10)
            .fillColor('#555')
            .text(input.subtitle, { align: 'center' })
            .fillColor('#000');
        }

        doc.moveDown(1.2);

        // Parágrafos: quebra em linha em branco preserva a estrutura; cada
        // parágrafo é justificado.
        const paragraphs = input.body
          .replace(/\r\n/g, '\n')
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter((p) => p.length > 0);

        doc.font('Helvetica').fontSize(11);
        for (const p of paragraphs) {
          doc.text(p, { align: 'justify', lineGap: 2 });
          doc.moveDown(0.7);
        }

        doc.end();
      } catch (err) {
        reject(err as Error);
      }
    });
  }
}
