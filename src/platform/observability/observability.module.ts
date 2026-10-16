import { Controller, Get, Global, Header, Inject, Injectable, Module } from '@nestjs/common';
import {
  ReconciliationObserver,
  type ReconciliationView,
} from '../../modules/wallet/application/wallet-service';
import { MetricsRecorder } from '../../shared/application/metrics';
import { Public } from '../auth/auth.guard';
import { UNIT_OF_WORK_OPTIONS, type UnitOfWorkOptions } from '../database/mikro-orm-unit-of-work';
import { PrometheusMetrics } from './prometheus-metrics';
import { ReadinessController, ReadinessService } from './readiness';

@Public()
@Controller('metrics')
class MetricsController {
  constructor(@Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}

@Injectable()
class MetricsReconciliationObserver extends ReconciliationObserver {
  constructor(@Inject(MetricsRecorder) private readonly metrics: MetricsRecorder) {
    super();
  }

  mismatch(_walletId: string, _report: ReconciliationView): void {
    this.metrics.reconciliationMismatch();
  }
}

@Global()
@Module({
  controllers: [MetricsController, ReadinessController],
  providers: [
    PrometheusMetrics,
    { provide: MetricsRecorder, useExisting: PrometheusMetrics },
    { provide: ReconciliationObserver, useClass: MetricsReconciliationObserver },
    {
      provide: UNIT_OF_WORK_OPTIONS,
      inject: [MetricsRecorder],
      useFactory: (metrics: MetricsRecorder): Partial<UnitOfWorkOptions> => ({
        onConflict: () => metrics.lockConflict(),
      }),
    },
    ReadinessService,
  ],
  exports: [MetricsRecorder, ReconciliationObserver, UNIT_OF_WORK_OPTIONS],
})
export class ObservabilityModule {}
