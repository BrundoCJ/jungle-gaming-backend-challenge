import { Module } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction';
import { WageringController } from './http/wagering.controller';
import { WagerMessageConsumer } from './messaging/wager-message-consumer';
import { PendingReferenceWorker } from './workers/pending-reference-worker';

@Module({
  controllers: [WageringController],
  providers: [ProcessWagerTransactionUseCase, WagerMessageConsumer, PendingReferenceWorker],
  exports: [ProcessWagerTransactionUseCase, WagerMessageConsumer, PendingReferenceWorker],
})
export class WageringModule {}
