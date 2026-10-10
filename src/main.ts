import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // helmet blocks cross-origin media by default; relax that for <audio>/<img>
  // tags served by this API (same origin, but browsers enforce CORP).
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.setGlobalPrefix('api/v1');

  // Webhooks de canal podem trazer a mídia embutida em base64 (Evolution manda
  // a foto/áudio/documento dentro do JSON), o que estoura o limite padrão de
  // 100kb e derrubava a mensagem com 413. Tem que ser via useBodyParser: um
  // express.json() registrado à mão faz o Nest NÃO registrar o parser global
  // e todas as outras rotas passam a receber body vazio.
  app.useBodyParser('json', { limit: '50mb' });

  // Serve locally-stored user uploads (audio, etc.) before the global prefix
  // kicks in. This is set up pre-prefix so the path matches both in dev and
  // behind the reverse-proxy.
  const uploadsDir = path.resolve(
    config.get<string>('UPLOADS_DIR') || path.join(process.cwd(), 'uploads'),
  );
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.use(
    '/api/v1/uploads',
    express.static(uploadsDir, {
      maxAge: '30d',
      fallthrough: false,
      index: false,
    }),
  );
  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN', 'http://localhost:3000'),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(), new ResponseInterceptor());

  const swagger = new DocumentBuilder()
    .setTitle('Chat BullQ API')
    .setDescription('Omnichannel customer service API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  const port = config.get<number>('PORT', 3001);
  await app.listen(port);
  logger.log(`API running on http://localhost:${port}`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
