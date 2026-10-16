import { Injectable } from '@nestjs/common';

export interface LivenessReport {
  status: 'ok';
  uptimeSeconds: number;
}

@Injectable()
export class HealthService {
  liveness(): LivenessReport {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }
}
