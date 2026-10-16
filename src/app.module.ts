import { Module } from '@nestjs/common';
import { HealthModule } from './platform/health/health.module';

@Module({
  imports: [HealthModule],
})
export class AppModule {}
