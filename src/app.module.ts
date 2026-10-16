import { Module } from '@nestjs/common';
import { WalletModule } from './modules/wallet/wallet.module';
import { ConfigModule } from './platform/config/config.module';
import { CoreModule } from './platform/core.module';
import { DatabaseModule } from './platform/database/database.module';
import { HealthModule } from './platform/health/health.module';
import { LoggingModule } from './platform/logging/logging.module';

@Module({
  imports: [ConfigModule, LoggingModule, DatabaseModule, CoreModule, HealthModule, WalletModule],
})
export class AppModule {}
