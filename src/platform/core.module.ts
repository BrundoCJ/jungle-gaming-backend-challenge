import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Clock, IdGenerator, SystemClock } from '../shared/application/clock';
import { ErrorMappingFilter } from './http/error-mapping';

class UuidV7Generator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

/** Cross-cutting application services: time, ids and HTTP error mapping. */
@Global()
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7Generator },
    { provide: APP_FILTER, useClass: ErrorMappingFilter },
  ],
  exports: [Clock, IdGenerator],
})
export class CoreModule {}
