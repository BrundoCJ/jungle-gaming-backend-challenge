import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { parseOrThrow } from '../../../platform/http/zod-validation';
import { identifier, uuid } from '../../../shared/application/contract-schemas';
import { InvalidRequestError, NotFoundError } from '../../../shared/application/errors';
import { UnitOfWork } from '../../../shared/application/unit-of-work';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction';
import {
  httpStatusFor,
  toResultView,
  toTransactionView,
  type WagerResultView,
  type WagerTransactionView,
} from '../application/wager-views';
import type { WagerTransaction } from '../domain/wager-transaction';
import { idempotencyKeySchema, wagerRequestSchema } from './wager-request.schema';

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerResultView> {
    const idempotencyKey = idempotencyKeySchema.safeParse(idempotencyKeyHeader);
    if (!idempotencyKey.success) {
      throw new InvalidRequestError(
        'MISSING_IDEMPOTENCY_KEY',
        'Idempotency-Key header is required',
      );
    }
    const payload = parseOrThrow(wagerRequestSchema, body);

    const outcome = await this.processWager.execute({
      payload,
      idempotencyKey: idempotencyKey.data,
      source: { channel: 'http' },
    });
    response.status(httpStatusFor(outcome.transaction.status));
    return toResultView(outcome);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string): Promise<WagerTransactionView> {
    const id = parseOrThrow(uuid, transactionId);
    return this.found(await this.uow.read((repos) => repos.transactions.findById(id)));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const provider = parseOrThrow(identifier, providerId);
    const external = parseOrThrow(identifier, externalTransactionId);
    return this.found(
      await this.uow.read((repos) => repos.transactions.findByExternalId(provider, external)),
    );
  }

  private found(transaction: WagerTransaction | null): WagerTransactionView {
    if (!transaction) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', 'transaction not found');
    }
    return toTransactionView(transaction);
  }
}
