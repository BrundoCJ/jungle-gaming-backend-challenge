import { IsolationLevel, MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  type Repositories,
  TransientInfrastructureError,
  UnitOfWork,
} from '../../shared/application/unit-of-work';
import {
  isLockConflict,
  isRetryableDatabaseError,
  isTransientDatabaseError,
} from './database-errors';
import { createRepositories } from './persistence/repositories';

export interface UnitOfWorkOptions {
  /** Max time a statement waits for a row lock before failing (55P03). */
  lockTimeoutMs: number;
  /** Attempts for retryable conflicts (deadlock, lock timeout, unique race). */
  maxAttempts: number;
  /** Called on every retried conflict; used for metrics. */
  onConflict?: (error: unknown, attempt: number) => void;
}

export const UNIT_OF_WORK_OPTIONS = Symbol('UNIT_OF_WORK_OPTIONS');

const DEFAULTS: UnitOfWorkOptions = { lockTimeoutMs: 2_000, maxAttempts: 3 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * READ COMMITTED transaction per unit of work, on a fresh EntityManager
 * fork. Row locks taken inside (SELECT ... FOR UPDATE on the wallet)
 * serialize work per wallet without any global lock.
 */
@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  private readonly options: UnitOfWorkOptions;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Optional() @Inject(UNIT_OF_WORK_OPTIONS) options?: Partial<UnitOfWorkOptions>,
  ) {
    super();
    this.options = { ...DEFAULTS, ...options };
  }

  async transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.orm.em.fork().transactional(
          async (em) => {
            await em.execute(
              `SET LOCAL lock_timeout = '${Math.trunc(this.options.lockTimeoutMs)}ms'`,
            );
            return work(createRepositories(em));
          },
          { isolationLevel: IsolationLevel.READ_COMMITTED },
        );
      } catch (error) {
        if (isLockConflict(error)) {
          this.options.onConflict?.(error, attempt);
        }
        if (isRetryableDatabaseError(error) && attempt < this.options.maxAttempts) {
          await sleep(10 * attempt + Math.random() * 40);
          continue;
        }
        if (isTransientDatabaseError(error)) {
          throw new TransientInfrastructureError('database temporarily unavailable or contended', {
            cause: error,
          });
        }
        throw error;
      }
    }
  }

  async read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      return await work(createRepositories(this.orm.em.fork()));
    } catch (error) {
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError('database temporarily unavailable', {
          cause: error,
        });
      }
      throw error;
    }
  }
}
