import type { NestExpressApplication } from '@nestjs/platform-express';
import { correlationMiddleware } from '../logging/correlation.middleware';

/** HTTP wiring shared by main.ts and tests that boot the real app. */
export function configureHttpApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.use(correlationMiddleware);
}
