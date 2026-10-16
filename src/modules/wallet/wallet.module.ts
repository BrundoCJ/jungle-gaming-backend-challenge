import { Module } from '@nestjs/common';
import { WalletService } from './application/wallet-service';
import { WalletController } from './http/wallet.controller';

@Module({
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
