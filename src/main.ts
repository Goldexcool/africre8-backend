import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { RedisIoAdapter } from './realtime/redis-io.adapter.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.set('trust proxy', 1); // Railway/nginx: rate limits must see the client IP, not the proxy's
  app.useBodyParser('json', { limit: '4mb' }); // KYC selfies (base64)
  app.enableCors();
  app.useWebSocketAdapter(new RedisIoAdapter(app));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
await bootstrap();
