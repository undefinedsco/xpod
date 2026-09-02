import { drizzle, type SolidAuthSession, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import { createXpodAiConnectionsPodStore } from '../../ui/src/extensions/XpodAiConnectionsPodStore';
import { loginWithClientCredentials, type AccountSetup } from '../integration/helpers/solidAccount';

type ProbeInput = {
  account: Pick<AccountSetup, 'clientId' | 'clientSecret' | 'webId' | 'podUrl' | 'issuer'>;
  provider?: string;
  credentialLabel?: string;
  expectedSecret?: string;
};

export type AiConnectionsPodProbeResult = {
  ok: true;
  provider: string;
  credentialId?: string;
  algorithm?: string;
  encoding?: string;
  readSecretMatches: boolean;
  rawContainsPlaintext: boolean;
  rawContainsEnvelope: boolean;
  providerCredentialCount: number;
  modelCount: number;
  selectedModelCount: number;
  unavailableModelCount: number;
  selectedUnavailableCount: number;
};

type ProbeFailure = { ok: false; error: 'probe_failed'; message: string; stackTop?: string };

async function main(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin()) as ProbeInput;
    const result = await probe(input);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    // Never echo account credentials, provider secrets, or upstream responses.
    const message = error instanceof Error ? error.message : 'unknown probe failure';
    const stackTop = error instanceof Error && error.stack
      ? error.stack.split('\n').slice(0, 3).join('\n')
      : undefined;
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'probe_failed',
      message,
      stackTop,
    } satisfies ProbeFailure));
    process.exitCode = 1;
  }
}

async function probe(input: ProbeInput): Promise<AiConnectionsPodProbeResult> {
  const provider = input.provider ?? 'openai';
  const session = await loginWithClientCredentials(input.account);
  const database = createPodDatabase(session, input.account);
  const store = createXpodAiConnectionsPodStore({
    database,
    webId: input.account.webId,
    podUrl: input.account.podUrl,
  });

  await database.init?.(
    credentialResource as never,
    aiProviderResource as never,
    aiModelResource as never,
  );
  const credentialRows = await database
    .select()
    .from(credentialResource)
    .execute() as Array<Record<string, unknown>>;
  const modelRows = await database
    .select()
    .from(aiModelResource)
    .execute() as Array<Record<string, unknown>>;
  const providerCredentialRows = credentialRows.filter((row) => {
    const rawProvider = String(row.provider ?? '').toLowerCase();
    const rawId = String(row.id ?? '').toLowerCase();
    return rawProvider.includes(provider.toLowerCase()) || rawId.startsWith(`${provider.toLowerCase()}-`);
  });
  const matchingCredential = input.credentialLabel
    ? providerCredentialRows.find((row) => String(row.accountLabel ?? row.label ?? '') === input.credentialLabel)
    : providerCredentialRows[0];

  let readSecretMatches = false;
  let algorithm: string | undefined;
  let encoding: string | undefined;
  let rawContainsPlaintext = false;
  let rawContainsEnvelope = false;
  if (matchingCredential) {
    const envelope = parseEnvelope(matchingCredential.encryptedSecret);
    algorithm = envelope?.algorithm;
    encoding = envelope?.encoding;
    if (input.expectedSecret) {
      const restored = await store.readCredentialSecret?.(provider, String(matchingCredential.id));
      readSecretMatches = restored?.apiKey === input.expectedSecret;
    }
  }

  const rawResponse = await session.fetch(new URL('settings/credentials.ttl', input.account.podUrl), {
    headers: { accept: 'text/turtle, application/ld+json;q=0.9, */*;q=0.1' },
  });
  const raw = rawResponse.ok ? await rawResponse.text() : '';
  if (input.expectedSecret) rawContainsPlaintext = raw.includes(input.expectedSecret);
  rawContainsEnvelope = raw.includes('PLAINTEXT') && raw.includes('base64');

  const providers = await store.listProviders();
  const providerSummary = providers.find((candidate: unknown) => (
    typeof candidate === 'object' && candidate !== null && (candidate as { id?: unknown }).id === provider
  )) as { selectedModels?: Array<{ availability?: string }> } | undefined;
  const providerModels = modelRows
    .map((row) => ({ provider: stringValue(row.isProvidedBy), status: stringValue(row.status) }))
    .filter((row) => row.provider?.includes(provider));
  const selectedModels = providerSummary?.selectedModels ?? [];

  return {
    ok: true,
    provider,
    ...(matchingCredential?.id ? { credentialId: String(matchingCredential.id) } : {}),
    ...(algorithm ? { algorithm } : {}),
    ...(encoding ? { encoding } : {}),
    readSecretMatches,
    rawContainsPlaintext,
    rawContainsEnvelope,
    providerCredentialCount: providerCredentialRows.length,
    modelCount: modelRows.length,
    selectedModelCount: selectedModels.length,
    unavailableModelCount: providerModels.filter((model) => model.status === 'unavailable').length,
    selectedUnavailableCount: selectedModels.filter((model) => model.availability === 'unavailable').length,
  };
}

function createPodDatabase(
  session: Awaited<ReturnType<typeof loginWithClientCredentials>>,
  account: Pick<AccountSetup, 'podUrl'>,
): SolidDatabase {
  const authSession: SolidAuthSession = { info: session.info, fetch: session.fetch };
  return drizzle(authSession, {
    podUrl: account.podUrl,
    schema: {
      aiModel: aiModelResource,
      aiProvider: aiProviderResource,
      credential: credentialResource,
    },
    autoConnect: false,
    resourcePreparation: 'off',
  }) as unknown as SolidDatabase;
}

function parseEnvelope(raw: unknown): { algorithm?: string; encoding?: string } | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof parsed.algorithm === 'string' ? { algorithm: parsed.algorithm } : {}),
      ...(typeof parsed.encoding === 'string' ? { encoding: parsed.encoding } : {}),
    };
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function readStdin(): Promise<string> {
  let content = '';
  for await (const chunk of process.stdin) content += String(chunk);
  return content;
}

await main();
