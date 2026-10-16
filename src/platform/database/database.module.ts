import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
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
  ],
  exports: [MikroORM],
})
export class DatabaseModule {}
