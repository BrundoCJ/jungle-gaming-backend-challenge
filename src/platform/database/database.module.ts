import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { UnitOfWork } from '../../shared/application/unit-of-work';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';
import { createOrmOptions } from './orm-options';

@Injectable()
class OrmLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => MikroORM.init(createOrmOptions(config.database.url)),
    },
    OrmLifecycle,
    { provide: UnitOfWork, useClass: MikroOrmUnitOfWork },
  ],
  exports: [MikroORM, UnitOfWork],
})
export class DatabaseModule {}
