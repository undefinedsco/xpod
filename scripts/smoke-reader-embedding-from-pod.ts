import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { Session } from '@inrupt/solid-client-authn-node';
import { drizzle, and, eq } from '@undefineds.co/drizzle-solid';
import { aiConfigModelRef, aiConfigProviderRef } from '@undefineds.co/models';
import { PodChatKitStore } from '../src/api/chatkit/pod-store';
import { CredentialReaderImpl } from '../src/ai/service/CredentialReaderImpl';
import { EmbeddingServiceImpl } from '../src/ai/service/EmbeddingServiceImpl';
import { ProviderRegistryImpl } from '../src/ai/service/ProviderRegistryImpl';
import { Provider } from '../src/ai/schema/provider';
import { Model } from '../src/ai/schema/model';
import { ModelType } from '../src/ai/schema/types';
import { Credential } from '../src/credential/schema/tables';
import { CredentialStatus, ServiceType } from '../src/credential/schema/types';
import { DefaultExtensionRuntime } from '../src/extensions/ExtensionRuntime';
import { PodCredentialResolver } from '../src/extensions/PodCredentialResolver';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const schema = { provider: Provider, model: Model, credential: Credential };
const baseUrl = process.env.XPOD_LOCAL_BASE_URL ?? process.env.CSS_BASE_URL ?? 'http://localhost:3000/';
const oidcIssuer = process.env.TEST_SOLID_OIDC_ISSUER ?? baseUrl;
const tokenEndpoint = process.env.CSS_TOKEN_ENDPOINT ?? new URL('/.oidc/token', baseUrl).toString();
const clientId = process.env.TEST_SOLID_CLIENT_ID;
const clientSecret = process.env.TEST_SOLID_CLIENT_SECRET;
const configuredWebId = process.env.TEST_SOLID_WEBID;
const dashscopeKey = process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY ?? '';
const paddleKey = process.env.PADDLEOCR_TOKEN ?? process.env.PADDLEOCR_API_KEY ?? '';
const paddleModel = process.env.PADDLEOCR_MODEL ?? 'PP-OCRv6';

function mask(value: string | undefined): string {
  if (!value) return 'missing';
  return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length})`;
}

function requireAuthEnv(): void {
  if (!clientId || !clientSecret) {
    throw new Error('TEST_SOLID_CLIENT_ID and TEST_SOLID_CLIENT_SECRET are required to write/read Pod settings');
  }
}

async function ensureContainer(doFetch: typeof fetch, url: string): Promise<void> {
  const head = await doFetch(url, { method: 'HEAD' });
  if (head.ok) return;
  if (head.status !== 404) {
    throw new Error(`Cannot probe container ${url}: ${head.status} ${await head.text().catch(() => '')}`);
  }
  const put = await doFetch(url, {
    method: 'PUT',
    headers: {
      'content-type': 'text/turtle',
      link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });
  if (!put.ok && put.status !== 201 && put.status !== 204) {
    throw new Error(`Cannot create container ${url}: ${put.status} ${await put.text().catch(() => '')}`);
  }
}

async function upsertById(db: any, resource: any, id: string, values: Record<string, unknown>): Promise<void> {
  const existing = await db.findById(resource, id).catch(() => undefined);
  if (existing) {
    await db.updateById(resource, id, values);
    return;
  }
  try {
    await db.insert(resource).values({ id, ...values });
  } catch (error) {
    await db.updateById(resource, id, values).catch(() => { throw error; });
  }
}

async function upsertProviderCredential(db: any, providerId: string, apiKey: string, label: string): Promise<string | undefined> {
  if (!apiKey.trim()) return undefined;
  const existing = await db.select().from(Credential).where(and(
    eq(Credential.provider, aiConfigProviderRef(providerId)),
    eq(Credential.service, ServiceType.AI),
  ));
  const credentialId = existing[0]?.id ?? `cred_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const payload = {
    provider: aiConfigProviderRef(providerId),
    service: ServiceType.AI,
    status: CredentialStatus.ACTIVE,
    apiKey,
    label,
    isDefault: false,
  };
  if (existing[0]) {
    await db.updateById(Credential, credentialId, payload);
  } else {
    await db.insert(Credential).values({ id: credentialId, ...payload });
  }
  return credentialId;
}

function createSmokeImage(): string {
  const path = '/tmp/xpod-reader-pod-smoke.png';
  const script = `from PIL import Image, ImageDraw, ImageFont\nimg = Image.new('RGB', (900, 260), 'white')\nd = ImageDraw.Draw(img)\ntry:\n    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 38)\nexcept Exception:\n    font = None\nd.text((40, 60), 'Xpod Reader Pod Smoke Test', fill='black', font=font)\nd.text((40, 130), 'Chinese OCR test 12345', fill='black', font=font)\nimg.save('${path}')\n`;
  const scriptPath = '/tmp/xpod-reader-pod-smoke.py';
  writeFileSync(scriptPath, script);
  execFileSync('python3', [scriptPath], { stdio: 'ignore' });
  return path;
}


function extractReadText(result: { markdown?: string; text?: string; documents?: Array<{ text?: string }> }): string {
  return result.markdown
    ?? result.text
    ?? result.documents?.map((document) => document.text).filter(Boolean).join('\n\n')
    ?? '';
}

async function main(): Promise<void> {
  requireAuthEnv();
  console.log(JSON.stringify({
    stage: 'inputs',
    baseUrl,
    oidcIssuer,
    webId: configuredWebId ?? 'from-session',
    dashscopeKey: mask(dashscopeKey),
    paddleKey: mask(paddleKey),
  }));

  const solidClientId = clientId!;
  const solidClientSecret = clientSecret!;
  const session = new Session();
  await session.login({
    clientId: solidClientId,
    clientSecret: solidClientSecret,
    oidcIssuer,
    tokenType: process.env.SOLID_TOKEN_TYPE === 'Bearer' ? 'Bearer' : 'DPoP',
  });
  const webId = session.info.webId ?? configuredWebId;
  if (!session.info.isLoggedIn || !webId) throw new Error('Solid login failed');
  const podUrl = webId.replace(/profile\/card#me$/, '');
  await ensureContainer(session.fetch, `${podUrl}settings/`);
  await ensureContainer(session.fetch, `${podUrl}settings/providers/`);

  const db: any = drizzle(session, { schema });
  await db.init?.(Provider, Model, Credential).catch(() => undefined);

  await upsertById(db, Provider, 'dashscope', {
    displayName: 'DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    hasModel: aiConfigModelRef('dashscope', 'text-embedding-v4'),
    defaultModel: aiConfigModelRef('dashscope', 'text-embedding-v4'),
  });
  await upsertById(db, Model, 'text-embedding-v4', {
    displayName: 'text-embedding-v4',
    modelType: ModelType.EMBEDDING,
    dimension: 1024,
    isProvidedBy: aiConfigProviderRef('dashscope'),
    status: 'active',
  });
  await upsertById(db, Provider, 'paddleocr', {
    displayName: 'PaddleOCR',
    baseUrl: 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs',
    hasModel: aiConfigModelRef('paddleocr', paddleModel),
    defaultModel: aiConfigModelRef('paddleocr', paddleModel),
  });
  await upsertById(db, Model, paddleModel, {
    displayName: paddleModel,
    modelType: 'reader',
    isProvidedBy: aiConfigProviderRef('paddleocr'),
    status: 'active',
  });

  const dashscopeCredentialId = await upsertProviderCredential(db, 'dashscope', dashscopeKey, 'DashScope embedding key');
  const paddleCredentialId = await upsertProviderCredential(db, 'paddleocr', paddleKey, 'PaddleOCR reader key');
  console.log(JSON.stringify({ stage: 'pod-write', dashscopeCredentialId, paddleCredentialId }));

  const store = new PodChatKitStore({ tokenEndpoint });
  const context = {
    auth: {
      type: 'solid',
      webId,
      clientId: solidClientId,
      clientSecret: solidClientSecret,
    },
  } as any;
  const readerConfig = await store.getReaderConfig(context, 'paddleocr');
  console.log(JSON.stringify({
    stage: 'pod-read-reader-config',
    found: Boolean(readerConfig),
    providerId: readerConfig?.providerId,
    model: readerConfig?.model,
    credentialId: readerConfig?.credentialId,
    baseUrl: readerConfig?.baseUrl,
  }));

  const credentialReader = new CredentialReaderImpl();
  const embeddingCredential = await credentialReader.getAiCredential(podUrl, 'dashscope', session.fetch, webId);
  console.log(JSON.stringify({
    stage: 'pod-read-embedding-credential',
    found: Boolean(embeddingCredential),
    provider: embeddingCredential?.provider,
    baseUrl: embeddingCredential?.baseUrl,
  }));

  if (readerConfig?.credentialId) {
    const imagePath = createSmokeImage();
    const extensionRuntime = new DefaultExtensionRuntime({
      credentialResolver: new PodCredentialResolver({ credentialReader }),
      embeddingService: new EmbeddingServiceImpl(new ProviderRegistryImpl()),
    });
    const readStarted = Date.now();
    const extensionContext = {
      webId,
      podBaseUrl: podUrl,
      fetch: session.fetch,
    };
    const readResult = await extensionRuntime.read(extensionContext, {
      model: `${podUrl}settings/providers/${readerConfig.providerId}.ttl#${readerConfig.model}`,
      credential: `${podUrl}settings/credentials.ttl#${readerConfig.credentialId}`,
      source: `file://${imagePath}`,
      output: 'markdown',
      pages: '1',
    });
    const readText = extractReadText(readResult);
    console.log(JSON.stringify({
      stage: 'reader-e2e',
      ok: true,
      tookMs: Date.now() - readStarted,
      chars: readText.length,
      textPreview: readText.split('\n').slice(0, 2),
      readerProvider: readResult.reader,
      readerModel: readResult.model,
    }));

    if (embeddingCredential?.apiKey && readText) {
      const embedStarted = Date.now();
      const embeddingResult = await extensionRuntime.embed(extensionContext, {
        model: `${podUrl}settings/providers/${embeddingCredential.provider}.ttl#text-embedding-v4`,
        credential: embeddingCredential.credentialId ? `${podUrl}settings/credentials.ttl#${embeddingCredential.credentialId}` : undefined,
        texts: [readText],
      });
      const vectors = embeddingResult.vectors;
      console.log(JSON.stringify({
        stage: 'embedding-after-reader',
        ok: true,
        tookMs: Date.now() - embedStarted,
        vectors: vectors.length,
        dimensions: vectors.map((vector) => vector.length),
        finite: vectors.every((vector) => vector.every(Number.isFinite)),
      }));
    }
  } else {
    console.log(JSON.stringify({ stage: 'reader-e2e', skipped: true, reason: 'no PaddleOCR credential reference in Pod/env' }));
  }

  await session.logout().catch(() => undefined);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
