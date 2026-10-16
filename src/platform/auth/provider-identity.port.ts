/** Authenticated caller, as an external Identity Provider would describe it. */
export interface ProviderIdentity {
  /** Provider the credentials belong to; null while authentication is disabled. */
  providerId: string | null;
  subject: string;
}

/**
 * Extension point for authentication. A real adapter would validate an OIDC
 * access token (e.g. Keycloak/Zitadel JWKS) and map its claims to the
 * provider; the use case would then require payload.providerId to match.
 * Authentication is intentionally not implemented in this challenge (see
 * ARCHITECTURE.md), so the default adapter accepts every caller.
 */
export abstract class ProviderIdentityPort {
  abstract authenticate(authorizationHeader: string | undefined): Promise<ProviderIdentity | null>;
}

export class AllowAllProviderIdentity extends ProviderIdentityPort {
  async authenticate(): Promise<ProviderIdentity> {
    return { providerId: null, subject: 'anonymous' };
  }
}
