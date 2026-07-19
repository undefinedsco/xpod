import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Real local LinX chat E2E.
 *
 * Default mode verifies the local xpod chain: account creation, file-backed Pod
 * model settings, /v1/linx/local-chat SSE, and message persistence. Upstream
 * model 401/502/503 responses are reported but do not fail this mode if the
 * local user message and attachment records are preserved.
 *
 * Use --require-assistant (or LINX_E2E_REQUIRE_ASSISTANT=1) when the configured
 * provider key/channel is expected to be healthy. That mode requires assistant
 * streaming completion for text, and for attachment probes when enabled.
 */

type ProbeMode = 'text' | 'attachment';

interface AccountInfo {
  podName: string;
  podUrl: string;
  webId: string;
  apiKey: string;
}

interface Candidate {
  sourcePod: string;
  file: string;
  provider: string;
  baseUrl: string;
  model: string;
  models: string[];
}

interface ProbeResult {
  mode: ProbeMode;
  provider: string;
  sourcePod: string;
  baseUrl: string;
  model: string;
  httpStatus: number;
  sseEvents: string[];
  hasUserMessageEvent: boolean;
  hasAssistantDelta: boolean;
  hasAssistantDone: boolean;
  hasDone: boolean;
  hasError: boolean;
  markerSeen: boolean;
  messagesStatus: number;
  messageCount: number;
  messagesOk: boolean;
  attachmentPersisted?: boolean;
  error: string;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const xpodBaseUrl = normalizeUrl(process.env.XPOD_E2E_BASE_URL || 'http://localhost:5737');
const dataRoot = process.env.XPOD_E2E_DATA_ROOT || path.join(repoRoot, 'data');
const marker = `LINX_E2E_${Date.now()}`;
const requireAssistant = process.argv.includes('--require-assistant') || process.env.LINX_E2E_REQUIRE_ASSISTANT === '1';
const includeAttachment = !process.argv.includes('--text-only') && process.env.LINX_E2E_TEXT_ONLY !== '1';

async function main(): Promise<void> {
  const account = await setupAccount('qae2e');
  logJson({
    step: 'account-created',
    podName: account.podName,
    podUrl: account.podUrl,
    webId: account.webId,
  });

  const candidates = await discoverCandidates();
  logJson({
    step: 'candidates',
    count: candidates.length,
    candidates: candidates.map((candidate) => ({
      sourcePod: candidate.sourcePod,
      provider: candidate.provider,
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      modelCount: candidate.models.length,
    })),
  });

  if (candidates.length === 0) {
    throw new Error(`No model service candidates found under ${dataRoot}. Configure a Pod model service first.`);
  }

  const results: ProbeResult[] = [];
  for (const candidate of candidates) {
    const textResult = await callLocalChat(account, candidate, 'text');
    results.push(textResult);
    logJson({ step: 'probe', ...textResult });

    if (includeAttachment) {
      const attachmentResult = await callLocalChat(account, candidate, 'attachment');
      results.push(attachmentResult);
      logJson({ step: 'probe', ...attachmentResult });
    }

    if (results.some(isAssistantPass)) break;
  }

  const textAssistantPassed = results.some((result) => result.mode === 'text' && isAssistantPass(result));
  const attachmentAssistantPassed = !includeAttachment
    || results.some((result) => result.mode === 'attachment' && isAssistantPass(result));
  const assistantPassed = textAssistantPassed && attachmentAssistantPassed;
  const textLocalChainPassed = results.some((result) => result.mode === 'text' && isLocalChainPass(result));
  const attachmentLocalChainPassed = !includeAttachment
    || results.some((result) => result.mode === 'attachment' && isLocalChainPass(result));
  const localChainPassed = textLocalChainPassed && attachmentLocalChainPassed;
  logJson({
    step: 'summary',
    marker,
    assistantPassed,
    textAssistantPassed,
    attachmentAssistantPassed,
    localChainPassed,
    textLocalChainPassed,
    attachmentLocalChainPassed,
    requireAssistant,
    result: assistantPassed ? 'full-pass' : localChainPassed ? 'local-chain-pass-upstream-unavailable' : 'failed',
    results,
  });

  if (requireAssistant && !assistantPassed) {
    process.exit(2);
  }
  process.exit(localChainPassed || assistantPassed ? 0 : 2);
}

async function setupAccount(prefix: string): Promise<AccountInfo> {
  const createRes = await fetch(`${xpodBaseUrl}/.account/account/`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!createRes.ok) {
    throw new Error(`Create account failed: ${createRes.status} ${await createRes.text()}`);
  }

  const created = await createRes.json() as { authorization?: string };
  if (!created.authorization) {
    throw new Error('Create account response did not include an account token.');
  }

  const controlsRes = await fetch(`${xpodBaseUrl}/.account/`, {
    headers: {
      Accept: 'application/json',
      Authorization: `CSS-Account-Token ${created.authorization}`,
    },
  });
  if (!controlsRes.ok) {
    throw new Error(`Get account controls failed: ${controlsRes.status} ${await controlsRes.text()}`);
  }

  const controls = await controlsRes.json() as {
    controls?: {
      password?: { create?: string };
      account?: { pod?: string; clientCredentials?: string };
    };
  };
  const accountControls = controls.controls?.account;
  if (!accountControls?.pod || !accountControls.clientCredentials) {
    throw new Error('Account controls do not expose pod/clientCredentials endpoints.');
  }

  const podName = `${prefix}${Date.now()}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32);

  if (controls.controls?.password?.create) {
    await fetch(controls.controls.password.create, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `CSS-Account-Token ${created.authorization}`,
      },
      body: JSON.stringify({ email: `${podName}@test.local`, password: 'test123456' }),
    });
  }

  const podRes = await fetch(accountControls.pod, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `CSS-Account-Token ${created.authorization}`,
    },
    body: JSON.stringify({ name: podName }),
  });
  if (!podRes.ok) {
    throw new Error(`Create pod failed: ${podRes.status} ${await podRes.text()}`);
  }

  const podInfo = await podRes.json() as { pod?: string; webId?: string };
  const webId = podInfo.webId || `${xpodBaseUrl}/${podName}/profile/card#me`;
  const podUrl = podInfo.pod || `${xpodBaseUrl}/${podName}/`;

  const credsRes = await fetch(accountControls.clientCredentials, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `CSS-Account-Token ${created.authorization}`,
    },
    body: JSON.stringify({ name: `${podName}-client`, webId }),
  });
  if (!credsRes.ok) {
    throw new Error(`Create client credentials failed: ${credsRes.status} ${await credsRes.text()}`);
  }

  const creds = await credsRes.json() as { id?: string; secret?: string };
  if (!creds.id || !creds.secret) {
    throw new Error('Client credentials response did not include id/secret.');
  }

  return {
    podName,
    podUrl,
    webId,
    apiKey: `sk-${Buffer.from(`${creds.id}:${creds.secret}`).toString('base64')}`,
  };
}

async function discoverCandidates(): Promise<Candidate[]> {
  const sourcePods = await discoverSourcePods();
  const candidates: Candidate[] = [];

  for (const pod of sourcePods) {
    const dir = path.join(dataRoot, pod, 'settings/providers');
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const file of files.filter((entry) => entry.endsWith('.ttl')).sort()) {
      const ttl = await fs.readFile(path.join(dir, file), 'utf8');
      const baseUrl = extractBaseUrl(ttl);
      const models = extractModels(ttl);
      if (!baseUrl || models.length === 0) continue;
      const preferred = selectPreferredModel(models);
      candidates.push({
        sourcePod: pod,
        file,
        provider: providerIdFromFile(file),
        baseUrl,
        model: preferred,
        models,
      });
    }
  }

  return candidates;
}

async function discoverSourcePods(): Promise<string[]> {
  const explicit = process.env.LINX_E2E_SOURCE_PODS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicit?.length) return explicit;

  const entries = await fs.readdir(dataRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('qae2e'))
    .sort();
}

async function callLocalChat(account: AccountInfo, candidate: Candidate, mode: ProbeMode): Promise<ProbeResult> {
  await copyProvider(candidate.sourcePod, candidate.file, account.podName);

  const chatId = `${xpodBaseUrl}/${account.podName}/.data/chat/e2e-${mode}-${Date.now()}.ttl#this`;
  const threadId = `thread-${mode}-${Date.now()}`;
  const attachments = mode === 'attachment'
    ? [{
      filename: 'linx-e2e.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    }]
    : undefined;
  const res = await fetch(`${xpodBaseUrl}/v1/linx/local-chat`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.apiKey}`,
    },
    body: JSON.stringify({
      webId: account.webId,
      chatId,
      threadId,
      provider: candidate.provider,
      model: candidate.model,
      content: mode === 'attachment'
        ? `E2E image attachment test. Reply exactly: ${marker}`
        : `E2E text smoke test. Reply exactly: ${marker}`,
      stream: true,
      attachments,
    }),
  });

  const text = await res.text();
  const sseEvents = parseSseEvents(text);
  const messages = await fetchPersistedMessages(account, chatId, threadId);
  const attachmentPersisted = mode === 'attachment'
    ? messages.items.some((message) => message.richContent?.includes('linx-e2e.png'))
    : undefined;
  const error = extractErrorText(text);

  return {
    mode,
    provider: candidate.provider,
    sourcePod: candidate.sourcePod,
    baseUrl: candidate.baseUrl,
    model: candidate.model,
    httpStatus: res.status,
    sseEvents,
    hasUserMessageEvent: sseEvents.includes('user_message'),
    hasAssistantDelta: sseEvents.includes('assistant_delta'),
    hasAssistantDone: sseEvents.includes('assistant_done'),
    hasDone: sseEvents.includes('done'),
    hasError: sseEvents.includes('error') || Boolean(error),
    markerSeen: text.includes(marker),
    messagesStatus: messages.status,
    messageCount: messages.items.length,
    messagesOk: messages.status === 200 && messages.items.length >= (sseEvents.includes('assistant_done') ? 2 : 1),
    attachmentPersisted,
    error,
  };
}

async function fetchPersistedMessages(
  account: AccountInfo,
  chatId: string,
  threadId: string,
): Promise<{ status: number; items: Array<{ content?: string; richContent?: string }> }> {
  const messagesUrl = new URL(`${xpodBaseUrl}/v1/linx/local-chat/messages`);
  messagesUrl.searchParams.set('chatId', chatId);
  messagesUrl.searchParams.set('threadId', threadId);
  messagesUrl.searchParams.set('webId', account.webId);

  const res = await fetch(messagesUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${account.apiKey}`,
    },
  });
  const body = await res.json().catch(() => ({})) as { messages?: Array<{ content?: string; richContent?: string }> };
  return { status: res.status, items: Array.isArray(body.messages) ? body.messages : [] };
}

async function copyProvider(sourcePod: string, providerFile: string, targetPod: string): Promise<void> {
  const sourceProvider = path.join(dataRoot, sourcePod, 'settings/providers', providerFile);
  const sourceCredential = path.join(dataRoot, sourcePod, 'settings/credentials.ttl');
  const providerTtl = await fs.readFile(sourceProvider, 'utf8');
  const credentialTtl = await fs.readFile(sourceCredential, 'utf8');
  const targetProviderDir = path.join(dataRoot, targetPod, 'settings/providers');

  await fs.mkdir(targetProviderDir, { recursive: true });
  await fs.writeFile(
    path.join(targetProviderDir, providerFile),
    localizeText(providerTtl, sourcePod, targetPod),
    'utf8',
  );
  await fs.writeFile(
    path.join(dataRoot, targetPod, 'settings/credentials.ttl'),
    localizeText(credentialTtl, sourcePod, targetPod),
    'utf8',
  );
}

function localizeText(text: string, fromPod: string, toPod: string): string {
  return text
    .split(`${xpodBaseUrl}/${fromPod}/`).join(`${xpodBaseUrl}/${toPod}/`)
    .split(`/${fromPod}/settings/`).join(`/${toPod}/settings/`);
}

function providerIdFromFile(file: string): string {
  return file.replace(/\.ttl$/, '').toLowerCase();
}

function extractBaseUrl(ttl: string): string {
  const match = ttl.match(/(?:ai:baseUrl|<https:\/\/vocab\.xpod\.dev\/ai#baseUrl>)\s+"([^"]+)"/);
  return match?.[1] || '';
}

function extractModels(ttl: string): string[] {
  const models = new Set<string>();
  for (const match of ttl.matchAll(/#([^#>\s]+)>\s+(?:ai:modelType|<https:\/\/vocab\.xpod\.dev\/ai#modelType>)/g)) {
    models.add(match[1]);
  }
  for (const object of extractObjects(ttl, 'hasModel')) {
    const hash = object.lastIndexOf('#');
    if (hash >= 0) models.add(object.slice(hash + 1));
  }
  for (const object of extractObjects(ttl, 'defaultModel')) {
    const hash = object.lastIndexOf('#');
    if (hash >= 0) models.add(object.slice(hash + 1));
  }
  return [...models].filter(Boolean);
}

function extractObjects(ttl: string, predLocal: string): string[] {
  const patterns = [
    new RegExp(`ai:${predLocal}\\s+(?:<([^>]+)>|"([^"]*)"|([^;,.\\s]+))`, 'g'),
    new RegExp(`<https:\\/\\/vocab\\.xpod\\.dev\\/ai#${predLocal}>\\s+(?:<([^>]+)>|"([^"]*)"|([^;,.\\s]+))`, 'g'),
  ];
  return patterns.flatMap((pattern) => [...ttl.matchAll(pattern)]
    .map((match) => match[1] || match[2] || match[3])
    .filter(Boolean));
}

function selectPreferredModel(models: string[]): string {
  const requested = process.env.LINX_E2E_MODEL?.trim();
  if (requested && models.includes(requested)) return requested;
  return models.find((model) => model === 'gpt-5.5')
    || models.find((model) => /gpt-5\.[0-9]/.test(model))
    || models[0];
}

function parseSseEvents(text: string): string[] {
  return [...text.matchAll(/^event:\s*(.+)$/gm)].map((match) => match[1].trim());
}

function extractErrorText(text: string): string {
  const dataLines = [...text.matchAll(/^data:\s*(.+)$/gm)].map((match) => match[1]);
  const errorLine = dataLines.find((line) => /error|invalid|unauthorized|unavailable|failed/i.test(line));
  return redact(errorLine || '').slice(0, 500);
}

function isAssistantPass(result: ProbeResult): boolean {
  return result.httpStatus === 200
    && result.hasAssistantDelta
    && result.hasAssistantDone
    && result.hasDone
    && result.messagesOk
    && (result.mode !== 'attachment' || result.attachmentPersisted === true);
}

function isLocalChainPass(result: ProbeResult): boolean {
  return result.httpStatus === 200
    && result.hasUserMessageEvent
    && result.messagesOk
    && (result.hasAssistantDone || result.hasError)
    && (result.mode !== 'attachment' || result.attachmentPersisted === true);
}

function normalizeUrl(value: string): string {
  return value.replace(/\/$/, '');
}

function redact(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*/g, 'sk-***REDACTED***');
}

function logJson(value: unknown): void {
  console.log(redact(JSON.stringify(value)));
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.stack || error.message : String(error)));
  process.exit(1);
});
