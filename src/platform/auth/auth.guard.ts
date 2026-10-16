import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ProviderIdentityPort } from './provider-identity.port';

const PUBLIC_ROUTE = 'auth:public';

/** Marks a controller or route as reachable without credentials (health checks). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/**
 * Global guard: every route except @Public ones goes through the
 * ProviderIdentityPort. With the default adapter it lets every request in;
 * swapping the adapter enables real authentication without touching routes.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ProviderIdentityPort) private readonly identities: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request & { identity?: unknown }>();
    const identity = await this.identities.authenticate(request.header('authorization'));
    if (!identity) {
      throw new UnauthorizedException();
    }
    request.identity = identity;
    return true;
  }
}
