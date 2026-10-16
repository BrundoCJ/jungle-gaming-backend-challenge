import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { parseOrThrow } from '../../../platform/http/zod-validation';
import { moneySchema, uuid } from '../../../shared/application/contract-schemas';
import { type LedgerPageView, WalletService, type WalletView } from '../application/wallet-service';

const createWalletSchema = z.object({
  playerId: uuid,
  initialBalance: moneySchema,
});

const ledgerQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('wallets')
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown): Promise<WalletView> {
    return this.wallets.create(parseOrThrow(createWalletSchema, body));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.wallets.get(parseOrThrow(uuid, walletId));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown): Promise<LedgerPageView> {
    return this.wallets.ledger(
      parseOrThrow(uuid, walletId),
      parseOrThrow(ledgerQuerySchema, query),
    );
  }
}
