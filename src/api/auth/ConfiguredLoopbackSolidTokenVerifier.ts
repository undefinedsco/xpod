import { jwtVerify } from 'jose';
import { DPoPJTICache } from '@solid/access-token-verifier/dist/class/DPoPJTICache';
import { decodeBase64UrlEncodedJson } from '@solid/access-token-verifier/dist/algorithm/decodeBase64UrlEncodedJson';
import { parseSolidAuthorizationHeader } from '@solid/access-token-verifier/dist/algorithm/parseSolidAuthorizationHeader';
import { verifyDpopProof } from '@solid/access-token-verifier/dist/algorithm/verifyDpopProof';
import { verifySolidAccessTokenIssuer } from '@solid/access-token-verifier/dist/algorithm/verifySolidAccessTokenIssuer';
import { verifySolidAccessTokenRequiredClaims } from '@solid/access-token-verifier/dist/algorithm/verifySolidAccessTokenRequiredClaims';
import { ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM } from '@solid/access-token-verifier/dist/constant/ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM';
import {
  clockToleranceInSeconds,
  maxAccessTokenAgeInSeconds,
} from '@solid/access-token-verifier/dist/config';
import { isSolidAccessToken } from '@solid/access-token-verifier/dist/guard/isSolidAccessToken';
import type {
  DPoPOptions,
  RetrieveIssuerKeySetFunction,
  RetrieveOidcIssuersFunction,
  SolidAccessToken,
  SolidAccessTokenPayload,
  SolidTokenVerifierFunction,
} from '@solid/access-token-verifier/dist/type';

export interface ConfiguredLoopbackSolidTokenVerifierOptions {
  allowedHttpOrigin: string;
  getIssuers: RetrieveOidcIssuersFunction;
  getKeySet: RetrieveIssuerKeySetFunction;
}

/**
 * Mirrors @solid/access-token-verifier while admitting one explicitly configured
 * HTTP loopback origin. The upstream verifier accepts HTTP localhost but rejects
 * the equivalent 127/8 and ::1 desktop origins before signature verification.
 */
export function createConfiguredLoopbackSolidTokenVerifier(
  options: ConfiguredLoopbackSolidTokenVerifierOptions,
): SolidTokenVerifierFunction {
  const allowedHttpOrigin = configuredHttpLoopbackOrigin(options.allowedHttpOrigin);
  if (!allowedHttpOrigin) {
    throw new Error('Configured loopback verifier requires an HTTP loopback origin');
  }
  const dpopJtiCache = new DPoPJTICache();

  return async(authorizationHeader: string, dpop?: DPoPOptions): Promise<SolidAccessTokenPayload> => {
    const solidJwt = parseSolidAuthorizationHeader(authorizationHeader);
    const decodedPayload = decodeBase64UrlEncodedJson(solidJwt.jwsPayload);

    verifySolidAccessTokenRequiredClaims(decodedPayload);
    verifySecureUriClaim(decodedPayload.webid, allowedHttpOrigin);
    verifySecureUriClaim(decodedPayload.iss, allowedHttpOrigin);

    const issuers = await options.getIssuers(decodedPayload.webid);
    verifySolidAccessTokenIssuer(issuers, decodedPayload.iss);

    const { payload, protectedHeader } = await jwtVerify(
      solidJwt.value,
      await options.getKeySet(decodedPayload.iss),
      {
        audience: 'solid',
        algorithms: Array.from(ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM),
        maxTokenAge: `${maxAccessTokenAgeInSeconds}s`,
        clockTolerance: `${clockToleranceInSeconds}s`,
      },
    );
    const accessToken = {
      header: protectedHeader,
      payload,
      signature: solidJwt.jwsSignature,
    };
    isSolidAccessToken(accessToken);

    if (solidJwt.authenticationScheme === 'DPoP' || 'cnf' in accessToken.payload) {
      if (!dpop) {
        throw new Error('SolidIdentityDPoPError DPoP options missing for DPoP bound access token verification');
      }
      await verifyDpopProof(
        dpop.header,
        accessToken as SolidAccessToken,
        solidJwt.value,
        dpop.method,
        dpop.url,
        dpop.isDuplicateJTI ?? dpopJtiCache.isDuplicateJTI.bind(dpopJtiCache),
      );
    }

    return accessToken.payload;
  };
}

export function configuredHttpLoopbackOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && isLoopbackIp(url.hostname) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function verifySecureUriClaim(uri: string, allowedHttpOrigin: string): void {
  const url = new URL(uri);
  const isUpstreamSecure = url.protocol === 'https:'
    || (url.protocol === 'http:' && url.hostname.split('.').pop() === 'localhost');
  const isConfiguredLoopback = url.protocol === 'http:'
    && url.origin === allowedHttpOrigin
    && isLoopbackIp(url.hostname);

  if (!isUpstreamSecure && !isConfiguredLoopback) {
    throw new Error(`The URI claim could not be verified as secure: ${uri}`);
  }
}

function isLoopbackIp(hostname: string): boolean {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (normalized === '::1') {
    return true;
  }
  const octets = normalized.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
