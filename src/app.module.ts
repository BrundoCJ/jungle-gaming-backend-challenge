import { Module } from '@nestjs/common';
import { WageringModule } from './modules/wagering/wagering.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { AuthModule } from './platform/auth/auth.module';
import { ConfigModule } from './platform/config/config.module';
import { CoreModule } from './platform/core.module';
import { DatabaseModule } from './platform/database/database.module';
import { HealthModule } from './platform/health/health.module';
import { LoggingModule } from './platform/logging/logging.module';
import { MessagingModule } from './platform/messaging/messaging.module';
import { ObservabilityModule } from './platform/observability/observability.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    ObservabilityModule,
    DatabaseModule,
    CoreModule,
    AuthModule,
    MessagingModule,
    HealthModule,
    WalletModule,
    WageringModule,
  ],
})
export class AppModule {}
