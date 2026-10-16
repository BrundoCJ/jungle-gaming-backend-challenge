import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AllowAllProviderIdentity, ProviderIdentityPort } from './provider-identity.port';

@Module({
  providers: [
    { provide: ProviderIdentityPort, useClass: AllowAllProviderIdentity },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
