import { Module } from '@nestjs/common';
import { PendingReferenceWorker } from './application/pending-reference-worker';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction';
import { WageringController } from './http/wagering.controller';
import { WagerMessageConsumer } from './messaging/wager-message-consumer';

@Module({
  controllers: [WageringController],
  providers: [ProcessWagerTransactionUseCase, WagerMessageConsumer, PendingReferenceWorker],
  exports: [ProcessWagerTransactionUseCase, WagerMessageConsumer, PendingReferenceWorker],
})
export class WageringModule {}
