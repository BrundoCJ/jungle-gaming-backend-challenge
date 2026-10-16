import { Module } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction';
import { WageringController } from './http/wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [ProcessWagerTransactionUseCase],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
