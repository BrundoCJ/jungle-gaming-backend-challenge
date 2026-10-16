import { Controller, Get } from '@nestjs/common';
import { HealthService, type LivenessReport } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): LivenessReport {
    return this.health.liveness();
  }
}
