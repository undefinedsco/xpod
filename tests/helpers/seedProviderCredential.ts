/**
 * Seed a provider credential into an account's Pod through the product's own
 * write path.
 *
 * The settings applet performs the same write in the browser; this helper exists
 * so a test can establish the precondition from Node (the browser path currently
 * aborts the request after the server already accepted it). The key is read from
 * stdin and never echoed back.
 */
import { drizzle, type SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import { text } from 'node:stream/consumers';
import { createXpodAiConnectionsPodStore } from '../../ui/src/extensions/XpodAiConnectionsPodStore';
import { loginWithClientCredentials, type AccountSetup } from '../integration/helpers/solidAccount';

type SeedInput = {
  account: Pick<AccountSetup, 'clientId' | 'clientSecret' | 'webId' | 'podUrl' | 'issuer'>;
  provider: string;
  offeringId: string;
  apiKey: string;
  label: string;
};

const input = JSON.parse(await text(process.stdin)) as SeedInput;
const session = await loginWithClientCredentials(input.account);
const authSession: SolidAuthSession = { info: session.info, fetch: session.fetch };
const database = drizzle(authSession, {
  podUrl: input.account.podUrl,
  schema: { aiModel: aiModelResource, aiProvider: aiProviderResource, credential: credentialResource },
  autoConnect: false,
  resourcePreparation: 'off',
});
const store = createXpodAiConnectionsPodStore({
  database: database as never,
  authenticatedFetch: session.fetch,
  podUrl: input.account.podUrl,
  webId: input.account.webId,
});
const credential = await store.createApiKeyCredential!(input.provider as never, {
  offeringId: input.offeringId,
  apiKey: input.apiKey,
  label: input.label,
});
const providers = await store.listProviders();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const provider = providers.find((item) => isRecord(item) && item.id === input.provider);
console.log(JSON.stringify({
  ok: true,
  credentialId: isRecord(credential) && typeof credential.id === 'string' ? credential.id : null,
  credentialsForProvider: isRecord(provider) && Array.isArray(provider.credentials)
    ? provider.credentials.length
    : 0,
}));
