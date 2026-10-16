import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './platform/config/app-config';
import { configureHttpApp } from './platform/http/configure-http-app';
import { AppLogger } from './platform/logging/app-logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(AppLogger));
  configureHttpApp(app);
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
