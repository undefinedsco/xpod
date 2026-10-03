import {
  BadRequestHttpError,
  CredentialsExtractor,
  type Credentials,
  type HttpRequest,
  type JwkGenerator,
  type TargetExtractor,
} from '@solid/community-server';
import { DPoPJTICache } from '@solid/access-token-verifier/dist/class/DPoPJTICache';
import { verifyDpopProof } from '@solid/access-token-verifier/dist/algorithm/verifyDpopProof';
import { verifySolidAccessTokenRequiredClaims } from '@solid/access-token-verifier/dist/algorithm/verifySolidAccessTokenRequiredClaims';
import { ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM } from '@solid/access-token-verifier/dist/constant/ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM';
import { REQUEST_METHOD } from '@solid/access-token-verifier/dist/constant/REQUEST_METHOD';
import { clockToleranceInSeconds, maxAccessTokenAgeInSeconds } from '@solid/access-token-verifier/dist/config';
import { isSolidAccessToken } from '@solid/access-token-verifier/dist/guard/isSolidAccessToken';
import type { DPoPOptions, SolidAccessToken } from '@solid/access-token-verifier/dist/type';
import { decodeJwt, importJWK, jwtVerify, type KeyLike } from 'jose';
import { getLoggerFor } from 'global-logger-factory';
import { XPOD_DESKTOP_CLIENT_ID } from '../identity/oidc/RememberedClientGrantStore';

/**
 * Reads the host's own session for this issuer's Account controls.
 *
 * Account authority comes from this issuer's signature and its current Account/WebID links,
 * checked by ValidatingIdentityProviderHttpHandler. Dereferencing the WebID's profile here
 * would require public ingress to a managed Local Pod just to manage the issuer's own Account.
 * Resource servers still use the general Solid extractor and its profile issuer check.
 */
export class AccountHostDPoPCredentialsExtractor extends CredentialsExtractor {
  private readonly logger = getLoggerFor(this);
  private readonly issuer: string;
  private readonly hostClientIds: readonly string[];
  private readonly replay = new DPoPJTICache();
  private publicKey?: Promise<KeyLike | Uint8Array>;
  private readonly delegatedExtractor?: CredentialsExtractor;

  public constructor(
    private readonly originalUrlExtractor: TargetExtractor,
    private readonly jwkGenerator: JwkGenerator,
    baseUrl: string,
    hostClientIds?: string[],
    externalAccountIssuer?: string,
    externalIssuerExtractor?: CredentialsExtractor,
  ) {
    super();
    this.issuer = new URL(baseUrl).href;
    this.hostClientIds = hostClientIds ?? [XPOD_DESKTOP_CLIENT_ID];
    if (externalAccountIssuer?.trim() && new URL(externalAccountIssuer).href !== this.issuer) {
      if (!externalIssuerExtractor) {
        throw new Error('External Account issuer requires its existing credentials extractor');
      }
      // A managed Local SP is not the central issuer's Account authority. Keep its existing
      // Solid resource verification and local Account behavior; only the issuer uses this own-key path.
      this.delegatedExtractor = externalIssuerExtractor;
    }
  }

  public override async handle(request: HttpRequest): Promise<Credentials> {
    if (this.delegatedExtractor) {
      return this.delegatedExtractor.handleSafe(request);
    }
    const { authorization, dpop } = request.headers;
    // Native Account cookies/tokens retain their existing CSS authorization path.
    // Bearer Solid tokens never gain Account authority from this extractor.
    if (typeof authorization !== 'string' || !/^DPoP /iu.test(authorization)) {
      return {};
    }

    let stage = 'proof-header';
    try {
      if (typeof dpop !== 'string' || !dpop || !isDpopMethod(request.method)) {
        throw new Error('Missing DPoP proof or method');
      }
      const token = authorization.slice(5).trim();
      stage = 'access-token-signature';
      const { payload, protectedHeader } = await jwtVerify(
        token,
        await (this.publicKey ??= this.loadPublicKey().catch((error: unknown) => {
          this.publicKey = undefined;
          throw error;
        })),
        {
          issuer: this.issuer,
          audience: 'solid',
          algorithms: Array.from(ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM),
          maxTokenAge: `${maxAccessTokenAgeInSeconds}s`,
          clockTolerance: `${clockToleranceInSeconds}s`,
        },
      );
      stage = 'access-token-claims';
      verifySolidAccessTokenRequiredClaims(payload);
      const accessToken = { header: protectedHeader, payload, signature: token.split('.')[2] };
      isSolidAccessToken(accessToken);
      if (typeof payload.webid !== 'string' || !payload.webid
        || typeof payload.sub !== 'string' || !payload.sub
        || typeof payload.client_id !== 'string' || !payload.client_id) {
        throw new Error('Missing Account principal');
      }
      stage = 'webid';
      const webId = new URL(payload.webid);
      if (!['http:', 'https:'].includes(webId.protocol) || webId.username || webId.password) {
        throw new Error('Invalid Account WebID');
      }
      // Preserve upstream's legacy proofs without ath. A supplied malformed value must
      // not bypass its conditional hash check; full verification authenticates it below.
      stage = 'proof-claims';
      const proofClaims = decodeJwt(dpop);
      if (Object.prototype.hasOwnProperty.call(proofClaims, 'ath') &&
          (typeof proofClaims.ath !== 'string' || !proofClaims.ath)) {
        throw new Error('Invalid access token hash');
      }
      stage = 'account-target';
      const originalUrl = await this.originalUrlExtractor.handleSafe({ request });
      const target = new URL(originalUrl.path);
      const accountRoot = new URL('.account/', this.issuer);
      if (target.origin !== accountRoot.origin || !target.pathname.startsWith(accountRoot.pathname)) {
        throw new Error('Not an Account operation');
      }
      stage = 'proof-verification';
      await verifyDpopProof(
        dpop,
        accessToken as SolidAccessToken,
        token,
        request.method,
        originalUrl.path,
        this.replay.isDuplicateJTI.bind(this.replay),
      );
      if (!this.hostClientIds.includes(payload.client_id)) {
        return {};
      }
      return {
        agent: { webId: payload.webid },
        client: { clientId: payload.client_id },
        issuer: { url: this.issuer },
      };
    } catch (error: unknown) {
      // Verifier class names contain no claims. Messages may quote private data.
      const errorType = error instanceof Error ? error.constructor.name : 'Unknown';
      this.logger.warn(`Rejected Account host session at ${stage} (${errorType})`);
      // JWT/DPoP errors may quote claims or private URLs. Keep the wire refusal stable.
      throw new BadRequestHttpError('Invalid Account host session');
    }
  }

  private async loadPublicKey(): Promise<KeyLike | Uint8Array> {
    const key = await this.jwkGenerator.getPublicKey();
    // CSS drops kid when deriving its public key. Import the fixed public key directly:
    // this also supports persisted keys with a custom kid, without selecting any key from JWT claims.
    return importJWK(key, key.alg);
  }
}

function isDpopMethod(method: string | undefined): method is DPoPOptions['method'] {
  return typeof method === 'string' && REQUEST_METHOD.has(method as DPoPOptions['method']);
}
