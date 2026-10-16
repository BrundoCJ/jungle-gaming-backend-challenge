import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AppLogger } from './app-logger';
import { createRootLogger, ROOT_LOGGER } from './root-logger';

@Global()
@Module({
  providers: [
    {
      provide: ROOT_LOGGER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createRootLogger(config),
    },
    AppLogger,
  ],
  exports: [ROOT_LOGGER, AppLogger],
})
export class LoggingModule {}
