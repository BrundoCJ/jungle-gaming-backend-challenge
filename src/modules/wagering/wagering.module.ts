import { Module } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction';
import { WageringController } from './http/wagering.controller';
import { WagerMessageConsumer } from './messaging/wager-message-consumer';

@Module({
  controllers: [WageringController],
  providers: [ProcessWagerTransactionUseCase, WagerMessageConsumer],
  exports: [ProcessWagerTransactionUseCase, WagerMessageConsumer],
})
export class WageringModule {}
