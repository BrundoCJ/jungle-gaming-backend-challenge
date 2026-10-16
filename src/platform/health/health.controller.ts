import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import { HealthService, type LivenessReport } from './health.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): LivenessReport {
    return this.health.liveness();
  }
}
