/**
 * A client credential created a moment ago must be usable at the token endpoint immediately.
 *
 * Cloud deployments serve the IdP adapter from Redis with expiring storage
 * (`config/cloud.json`: `LoopbackClientIdAdapterFactory` → `ExpiringAdapterFactory` →
 * `WrappedExpiringStorage`). That is fine for tokens, but the *client registry* is authoritative:
 * creating a second credential for one account must not hide it behind a cached lookup. The 0.4.16
 * release candidate hit exactly that - the API validated a credential the acceptance had created a
 * second earlier and the IdP answered `invalid_client - client authentication failed - client not
 * found` - so this locks the behaviour on a Postgres + Redis cloud runtime.
 *
 * Runs under `bun run test:integration:full` (cloud runtime on CLOUD_PORT).
 */

import { describe, expect, it } from 'vitest';

import { createClientCredentials, getAccountControls, login } from '../../packages/xpod-cli/src/lib/css-account';
import { getClientCredentialsToken, setupAccount } from './helpers/solidAccount';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;
const CLOUD_PORT = process.env.CLOUD_PORT || '6300';
const CLOUD_BASE_URL = `http://localhost:${CLOUD_PORT}`;

/** The account controls shape differs between a bare CSS and the Cloud account host. */
function clientCredentialsControlUrl(controls: unknown): string | undefined {
  const record = controls as {
    clientCredentials?: unknown;
    account?: { clientCredentials?: unknown };
  } | undefined;
  const candidate = record?.clientCredentials ?? record?.account?.clientCredentials;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

suite('Cloud client credential visibility', () => {
  it('exchanges a second, freshly created client credential without waiting for a cache', async () => {
    const account = await setupAccount(CLOUD_BASE_URL, 'credential-visibility');
    expect(account, 'Cloud account setup failed').not.toBeNull();

    // The account's first credential (the one a session logs in with) works.
    await expect(getClientCredentialsToken(account!)).resolves.toMatchObject({
      accessToken: expect.any(String),
    });

    const accountToken = await login(account!.email!, account!.password!, CLOUD_BASE_URL);
    expect(accountToken, 'Cloud password login failed').toBeTruthy();
    const controls = await getAccountControls(accountToken!, CLOUD_BASE_URL);
    const credentialsUrl = clientCredentialsControlUrl(controls);
    expect(credentialsUrl, `Cloud controls expose no clientCredentials endpoint: ${JSON.stringify(controls)}`)
      .toBeTruthy();

    const second = await createClientCredentials(
      accountToken!,
      credentialsUrl!,
      account!.webId,
      `visibility-second-${Date.now()}`,
    );
    expect(second, 'Creating the second Cloud client credential failed').not.toBeNull();
    expect(second!.secret, 'Cloud client credential response carried no secret').toBeTruthy();

    // Used immediately, exactly as `POST /api/ai/gateway/keys` validates a wrapper the caller just
    // created: no wait, no retry, no second attempt.
    await expect(getClientCredentialsToken({
      ...account!,
      clientId: second!.id,
      clientSecret: second!.secret!,
    })).resolves.toMatchObject({ accessToken: expect.any(String) });
  }, 120000);
});
