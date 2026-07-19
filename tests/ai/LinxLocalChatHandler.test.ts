import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

const queryMock = vi.fn();
const connectMock = vi.fn();

vi.mock('../../src/storage/database/PostgresPoolManager', () => ({
  getSharedPool: () => ({
    query: queryMock,
    connect: connectMock,
  }),
}));

const {
  registerLinxLocalChatRoutes,
  resolveLocalAIConfig,
  selectLocalAICandidates,
} = await import('../../src/api/handlers/LinxLocalChatHandler');

const {
  readPodLocalAIConfig,
  recordCandidateSuccess,
} = await import('../../src/api/service/LinxModelConfigRepository');

describe('LinxLocalChatHandler local AI config routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEFAULT_PROVIDER;
    delete process.env.DEFAULT_MODEL;
    delete process.env.DEFAULT_API_BASE;
    delete process.env.DEFAULT_API_KEY;
    process.env.CSS_BASE_URL = 'http://localhost:5737/';
    connectMock.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('orders failover credentials with the default endpoint first', () => {
    const candidates = selectLocalAICandidates('openai-main', [
      {
        id: 'backup',
        graph: 'http://localhost:5737/cuilinsu/settings/credentials.ttl',
        subject: 'http://localhost:5737/cuilinsu/settings/credentials.ttl#backup',
        providerId: 'openai-main',
        service: 'ai',
        status: 'active',
        apiKey: 'sk-backup',
        baseUrl: 'https://backup.example/v1',
        failCount: 0,
      },
      {
        id: 'main',
        graph: 'http://localhost:5737/cuilinsu/settings/credentials.ttl',
        subject: 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main',
        providerId: 'openai-main',
        service: 'ai',
        status: 'active',
        apiKey: 'sk-main',
        baseUrl: 'https://main.example/v1',
        isDefault: true,
        failCount: 1,
      },
    ], [{
      id: 'openai-main',
      graph: 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl',
      subject: 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl',
      routingPolicy: 'failover',
    }]);

    expect(candidates.map((candidate) => candidate.credentialId)).toEqual(['main', 'backup']);
  });

  it('keeps weighted routing inside the healthiest fail-count bucket', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const candidates = selectLocalAICandidates('openai-main', [
      {
        id: 'healthy',
        graph: 'http://localhost:5737/cuilinsu/settings/credentials.ttl',
        subject: 'http://localhost:5737/cuilinsu/settings/credentials.ttl#healthy',
        providerId: 'openai-main',
        service: 'ai',
        status: 'active',
        apiKey: 'sk-healthy',
        baseUrl: 'https://healthy.example/v1',
        weight: 1,
        failCount: 0,
      },
      {
        id: 'unhealthy-heavy',
        graph: 'http://localhost:5737/cuilinsu/settings/credentials.ttl',
        subject: 'http://localhost:5737/cuilinsu/settings/credentials.ttl#unhealthy-heavy',
        providerId: 'openai-main',
        service: 'ai',
        status: 'active',
        apiKey: 'sk-unhealthy',
        baseUrl: 'https://unhealthy.example/v1',
        weight: 1000,
        failCount: 5,
      },
    ], [{
      id: 'openai-main',
      graph: 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl',
      subject: 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl',
      routingPolicy: 'weighted',
    }]);

    expect(candidates[0]?.credentialId).toBe('healthy');
  });

  it('resolves Pod model service endpoints before env fallback', async () => {
    process.env.DEFAULT_PROVIDER = 'openai';
    process.env.DEFAULT_MODEL = 'env-model';
    process.env.DEFAULT_API_BASE = 'https://env.example/v1';
    process.env.DEFAULT_API_KEY = 'sk-env';

    queryMock.mockResolvedValue({
      rows: [
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#baseUrl', 'https://provider.example/v1'),
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#routingPolicy', 'failover'),
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#hasModel', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl#gpt-5.5'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#provider', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'iri'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#service', 'ai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#status', 'active'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#apiKey', 'sk-pod'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#baseUrl', 'https://pod.example/v1'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#isDefault', 'true'),
      ],
    });

    const config = await resolveLocalAIConfig({
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
    });

    expect(config.source).toBe('pod');
    expect(config.providerId).toBe('openai-main');
    expect(config.model).toBe('gpt-5.5');
    expect(config.candidates).toHaveLength(1);
    expect(config.candidates[0]).toEqual(expect.objectContaining({
      credentialId: 'main',
      baseUrl: 'https://pod.example/v1',
    }));
  });

  it('uses env config first for the default local chat provider to avoid probing empty Pod credentials', async () => {
    process.env.DEFAULT_PROVIDER = 'openai';
    process.env.DEFAULT_MODEL = 'gpt-5.5';
    process.env.DEFAULT_API_BASE = 'https://env.example/v1';
    process.env.DEFAULT_API_KEY = 'sk-env';

    const config = await resolveLocalAIConfig({
      provider: 'openai',
      model: 'gpt-5.5',
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
    });

    expect(config.source).toBe('env');
    expect(config.providerId).toBe('openai');
    expect(config.model).toBe('gpt-5.5');
    expect(config.candidates[0]).toEqual(expect.objectContaining({
      apiKey: 'sk-env',
      baseUrl: 'https://env.example/v1',
    }));
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('does not fetch missing local credential resources when file-backed Pod config is empty', async () => {
    process.env.DEFAULT_PROVIDER = 'openai';
    process.env.DEFAULT_MODEL = 'gpt-5.5';
    process.env.DEFAULT_API_BASE = 'https://env.example/v1';
    process.env.DEFAULT_API_KEY = 'sk-env';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linx-empty-model-config-'));
    const resourceFetch = vi.fn(async () => new Response('', { status: 401 }));

    const podConfig = await readPodLocalAIConfig('openai', 'http://localhost:5737/cuilinsu/profile/card#me', {
      fileRootPath: root,
      resourceFetch: resourceFetch as typeof fetch,
    });

    expect(podConfig).toBeNull();
    expect(resourceFetch).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('reads model service configuration from Pod resources before database fallback', async () => {
    const credentialUrl = 'http://localhost:5737/cuilinsu/settings/credentials.ttl';
    const providerUrl = 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl';
    const resourceFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === credentialUrl) {
        return new Response(`
<${credentialUrl}#main>
  <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://vocab.xpod.dev/credential#Credential> ;
  <https://vocab.xpod.dev/credential#provider> <${providerUrl}> ;
  <https://vocab.xpod.dev/credential#service> "ai" ;
  <https://vocab.xpod.dev/credential#status> "active" ;
  <https://vocab.xpod.dev/credential#apiKey> "sk-pod-resource" ;
  <https://vocab.xpod.dev/credential#baseUrl> "https://resource.example/v1" ;
  <https://vocab.xpod.dev/credential#isDefault> true .
`, { status: 200, headers: { 'Content-Type': 'text/turtle' } });
      }
      if (url === providerUrl) {
        return new Response(`
<${providerUrl}>
  <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://vocab.xpod.dev/ai#Provider> ;
  <https://vocab.xpod.dev/ai#routingPolicy> "failover" ;
  <https://vocab.xpod.dev/ai#defaultModel> <${providerUrl}#gpt-5.5> .
`, { status: 200, headers: { 'Content-Type': 'text/turtle' } });
      }
      return new Response('', { status: 404 });
    });

    const config = await readPodLocalAIConfig(
      'openai-main',
      'http://localhost:5737/cuilinsu/profile/card#me',
      { resourceFetch: resourceFetch as any, allowDatabaseFallback: false },
    );

    expect(config).toEqual(expect.objectContaining({
      providerId: 'openai-main',
      model: 'gpt-5.5',
    }));
    expect(config?.candidates[0]).toEqual(expect.objectContaining({
      credentialId: 'main',
      apiKey: 'sk-pod-resource',
      baseUrl: 'https://resource.example/v1',
    }));
    expect(queryMock).not.toHaveBeenCalled();
    expect(resourceFetch).toHaveBeenCalledWith(credentialUrl, expect.objectContaining({
      headers: { Accept: 'text/turtle' },
    }));
  });

  it('normalizes root-relative Pod provider IRIs parsed from Turtle resources', async () => {
    const credentialUrl = 'http://localhost:5737/cuilinsu/settings/credentials.ttl';
    const providerUrl = 'http://localhost:5737/cuilinsu/settings/providers/openai-test.ttl';
    const resourceFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === credentialUrl) {
        return new Response(`
@prefix cred: <https://vocab.xpod.dev/credential#> .
<${credentialUrl}#main>
  a cred:Credential ;
  cred:provider </settings/providers/openai-test.ttl> ;
  cred:service "ai" ;
  cred:status "active" ;
  cred:apiKey "sk-pod-resource" ;
  cred:baseUrl "https://resource.example/v1" .
`, { status: 200, headers: { 'Content-Type': 'text/turtle' } });
      }
      if (url === providerUrl) {
        return new Response(`
@prefix ai: <https://vocab.xpod.dev/ai#> .
<${providerUrl}>
  a ai:Provider ;
  ai:hasModel <${providerUrl}#gpt-5.5> .
`, { status: 200, headers: { 'Content-Type': 'text/turtle' } });
      }
      return new Response('', { status: 404 });
    });

    const config = await readPodLocalAIConfig(
      'openai-test',
      'http://localhost:5737/cuilinsu/profile/card#me',
      { resourceFetch: resourceFetch as any, allowDatabaseFallback: false },
    );

    expect(config).toEqual(expect.objectContaining({
      providerId: 'openai-test',
      model: 'gpt-5.5',
    }));
    expect(config?.candidates[0]).toEqual(expect.objectContaining({
      credentialId: 'main',
      baseUrl: 'https://resource.example/v1',
    }));
    expect(resourceFetch).toHaveBeenCalledWith(providerUrl, expect.anything());
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('writes credential health back through the Pod credential resource first', async () => {
    const credentialUrl = 'http://localhost:5737/cuilinsu/settings/credentials.ttl';
    const resourceFetch = vi.fn(async () => new Response(null, { status: 204 }));

    await recordCandidateSuccess({
      providerId: 'openai-main',
      credentialId: 'main',
      credentialSubject: `${credentialUrl}#main`,
      credentialGraph: credentialUrl,
      credential: { failCount: 3 },
      apiKey: 'sk-pod-resource',
      baseUrl: 'https://resource.example/v1',
    }, { resourceFetch: resourceFetch as any, allowDatabaseFallback: false });

    expect(connectMock).not.toHaveBeenCalled();
    expect(resourceFetch).toHaveBeenCalledWith(credentialUrl, expect.objectContaining({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
    }));
    const patch = resourceFetch.mock.calls[0]?.[1]?.body as string;
    expect(patch).toContain('DELETE');
    expect(patch).toContain('INSERT');
    expect(patch).toContain('<https://vocab.xpod.dev/credential#failCount> 0');
    expect(patch).toContain('<https://vocab.xpod.dev/credential#status> "active"');
  });

  it('reads and updates file-backed model service settings without database fallback', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linx-model-config-'));
    const credentialPath = path.join(root, 'cuilinsu/settings/credentials.ttl');
    const providerPath = path.join(root, 'cuilinsu/settings/providers/openai-main.ttl');
    const credentialUrl = 'http://localhost:5737/cuilinsu/settings/credentials.ttl';
    const providerUrl = 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl';

    await fs.mkdir(path.dirname(providerPath), { recursive: true });
    await fs.writeFile(credentialPath, `
<${credentialUrl}#main>
  <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://vocab.xpod.dev/credential#Credential> ;
  <https://vocab.xpod.dev/credential#provider> <${providerUrl}> ;
  <https://vocab.xpod.dev/credential#service> "ai" ;
  <https://vocab.xpod.dev/credential#status> "active" ;
  <https://vocab.xpod.dev/credential#apiKey> "sk-file" ;
  <https://vocab.xpod.dev/credential#failCount> 4 ;
  <https://vocab.xpod.dev/credential#baseUrl> "https://file.example/v1" .
`, 'utf8');
    await fs.writeFile(providerPath, `
<${providerUrl}>
  <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://vocab.xpod.dev/ai#Provider> ;
  <https://vocab.xpod.dev/ai#defaultModel> <${providerUrl}#gpt-5.5> .
`, 'utf8');

    const config = await readPodLocalAIConfig(
      'openai-main',
      'http://localhost:5737/cuilinsu/profile/card#me',
      { fileRootPath: root },
    );

    expect(config?.model).toBe('gpt-5.5');
    expect(config?.candidates[0]).toEqual(expect.objectContaining({
      credentialId: 'main',
      apiKey: 'sk-file',
      baseUrl: 'https://file.example/v1',
    }));
    expect(queryMock).not.toHaveBeenCalled();

    await recordCandidateSuccess(config!.candidates[0], { fileRootPath: root });
    const updated = await fs.readFile(credentialPath, 'utf8');
    expect(updated).toContain('cred:failCount 0');
    expect(updated).toContain('cred:status "active"');
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('does not use model credentials from another local Pod', async () => {
    queryMock.mockResolvedValue({
      rows: [
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#baseUrl', 'https://openai.example/v1'),
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#hasModel', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl#gpt-5.5'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#provider', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'iri'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#service', 'ai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#status', 'active'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#apiKey', 'sk-other-user'),
      ],
    });

    const config = await resolveLocalAIConfig({
      provider: 'openai-main',
      model: 'gpt-5.5',
      webId: 'http://localhost:5737/qa234350/profile/card#me',
    });

    expect(config.source).toBe('none');
    expect(config.candidates).toHaveLength(0);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('graph LIKE $3'),
      expect.arrayContaining(['http://localhost:5737/qa234350/']),
    );
  });

  it('rejects local chat requests that spoof another authenticated webId', async () => {
    const response = await callLocalChatRoute({
      chatId: 'chat-1',
      threadId: 'thread-1',
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
      content: 'spoof',
      authWebId: 'http://localhost:5737/qa234350/profile/card#me',
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toContain('webId does not match authenticated user');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects chat graphs outside the authenticated Pod', async () => {
    const response = await callLocalChatRoute({
      chatId: 'http://localhost:5737/qa234350/.data/chat/private.ttl#this',
      threadId: 'thread-1',
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
      content: 'cross-pod write',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain('chatId, threadId');
    expect(queryMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('honors an explicit provider from the web chat request', async () => {
    queryMock.mockResolvedValue({
      rows: [
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#baseUrl', 'https://openai.example/v1'),
        row('http://localhost:5737/cuilinsu/settings/providers/timicc.ttl', 'http://localhost:5737/cuilinsu/settings/providers/timicc.ttl', 'https://vocab.xpod.dev/ai#baseUrl', 'https://timicc.example/v1'),
        row('http://localhost:5737/cuilinsu/settings/providers/timicc.ttl', 'http://localhost:5737/cuilinsu/settings/providers/timicc.ttl', 'https://vocab.xpod.dev/ai#hasModel', 'http://localhost:5737/cuilinsu/settings/providers/timicc.ttl#gpt-5.5'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#openai', 'https://vocab.xpod.dev/credential#provider', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'iri'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#openai', 'https://vocab.xpod.dev/credential#service', 'ai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#openai', 'https://vocab.xpod.dev/credential#status', 'active'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#openai', 'https://vocab.xpod.dev/credential#apiKey', 'sk-openai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#timicc', 'https://vocab.xpod.dev/credential#provider', 'http://localhost:5737/cuilinsu/settings/providers/timicc.ttl', 'iri'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#timicc', 'https://vocab.xpod.dev/credential#service', 'ai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#timicc', 'https://vocab.xpod.dev/credential#status', 'active'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#timicc', 'https://vocab.xpod.dev/credential#apiKey', 'sk-timicc'),
      ],
    });

    const config = await resolveLocalAIConfig({
      provider: 'timicc',
      model: 'gpt-5.5',
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
    });

    expect(config.providerId).toBe('timicc');
    expect(config.model).toBe('gpt-5.5');
    expect(config.candidates[0]).toEqual(expect.objectContaining({
      credentialId: 'timicc',
      baseUrl: 'https://timicc.example/v1',
    }));
  });

  it('uses the Responses API for the local LinX chat route', async () => {
    queryMock.mockResolvedValue({
      rows: [
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#baseUrl', 'https://openai.example/v1'),
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#hasModel', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl#gpt-5.5'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#provider', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'iri'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#service', 'ai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#status', 'active'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#apiKey', 'sk-pod'),
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: 'pong' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as any);

    const response = await callLocalChatRoute({
      chatId: 'chat-1',
      threadId: 'thread-1',
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
      content: '请只回复 pong',
      provider: 'openai-main',
      model: 'gpt-5.5',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).assistantMessage.content).toBe('pong');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openai.example/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer sk-pod',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual(expect.objectContaining({
      model: 'gpt-5.5',
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: '请只回复 pong' }],
      }],
      stream: false,
    }));
  });

  it('persists the user message before a streaming upstream failure', async () => {
    queryMock.mockResolvedValue({
      rows: [
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#baseUrl', 'https://openai.example/v1'),
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#hasModel', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl#gpt-5.5'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#provider', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'iri'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#service', 'ai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#status', 'active'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#apiKey', 'sk-pod'),
      ],
    });
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    connectMock.mockResolvedValue({
      query: clientQuery,
      release: vi.fn(),
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Invalid API key' },
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }) as any);

    const response = await callLocalChatRoute({
      chatId: 'http://localhost:5737/cuilinsu/.data/chat/stream-failure.ttl#this',
      threadId: 'thread-1',
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
      content: '上游失败也要留档',
      provider: 'openai-main',
      model: 'gpt-5.5',
      stream: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: user_message');
    expect(response.body).toContain('event: error');
    expect(response.body).toContain('LLM request failed: 401');

    const insertParams = clientQuery.mock.calls
      .filter((call) => String(call[0]).includes('INSERT INTO quints'))
      .map((call) => call[1])
      .filter((params) => params[0] === 'http://localhost:5737/cuilinsu/.data/chat/stream-failure.ttl');
    expect(insertParams).toHaveLength(8);
    expect(insertParams.some((params) => params[2] === 'https://undefineds.co/ns#messageType' && params[6] === 'user')).toBe(true);
    expect(insertParams.some((params) => params[2] === 'http://rdfs.org/sioc/ns#content' && params[6] === '上游失败也要留档')).toBe(true);
  });

  it('persists local chat messages into the selected chat document graph', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    connectMock.mockResolvedValue({
      query: clientQuery,
      release: vi.fn(),
    });

    const response = await callLocalChatRoute({
      chatId: 'http://localhost:5737/cuilinsu/.data/chat/ai-secretary.ttl#this',
      threadId: 'http://localhost:5737/cuilinsu/.data/chat/ai-secretary.ttl#thread-1',
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
      content: '本地留档路径验证',
    });

    expect(response.statusCode).toBe(200);
    const insertParams = clientQuery.mock.calls
      .filter((call) => String(call[0]).includes('INSERT INTO quints'))
      .map((call) => call[1]);

    expect(insertParams).toHaveLength(16);
    expect(insertParams.every((params) => params[0] === 'http://localhost:5737/cuilinsu/.data/chat/ai-secretary.ttl')).toBe(true);
    expect(insertParams.some((params) => params[1] === 'http://localhost:5737/cuilinsu/.data/chat/ai-secretary.ttl#thread-1')).toBe(true);
  });

  it('passes image and file attachments through the Responses API input content', async () => {
    queryMock.mockResolvedValue({
      rows: [
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#baseUrl', 'https://openai.example/v1'),
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#hasModel', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl#gpt-5.5'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#provider', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'iri'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#service', 'ai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#status', 'active'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#apiKey', 'sk-pod'),
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: 'attachments ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as any);
    const imageDataUrl = `data:image/png;base64,${'a'.repeat(4096)}`;

    const response = await callLocalChatRoute({
      chatId: 'chat-1',
      threadId: 'thread-1',
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
      content: '请描述附件',
      provider: 'openai-main',
      model: 'gpt-5.5',
      attachments: [
        {
          filename: 'pixel.png',
          mimeType: 'image/png',
          dataUrl: imageDataUrl,
          fileData: 'aW1n',
        },
        {
          filename: 'notes.txt',
          mimeType: 'text/plain',
          fileData: 'aGVsbG8=',
        },
      ],
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: '请描述附件' },
      { type: 'input_image', image_url: imageDataUrl },
      { type: 'input_file', file_data: 'aGVsbG8=', filename: 'notes.txt' },
    ]);

    const client = await connectMock.mock.results[0].value;
    const richContentInsert = client.query.mock.calls.find((call: unknown[]) => {
      const params = call[1] as unknown[] | undefined;
      return params?.[2] === 'http://rdfs.org/sioc/ns#richContent';
    });
    expect(richContentInsert).toBeTruthy();
    const richContentParams = richContentInsert?.[1] as unknown[];
    expect(richContentParams[5]).toMatch(/^sha256:/);
    const richContent = JSON.parse(richContentParams[6] as string);
    expect(richContent).toEqual({
      items: [
        {
          type: 'image',
          url: imageDataUrl,
          metadata: {
            filename: 'pixel.png',
            mimeType: 'image/png',
          },
        },
        {
          type: 'file',
          fileName: 'notes.txt',
          fileUrl: 'data:text/plain;base64,aGVsbG8=',
          mimeType: 'text/plain',
        },
      ],
    });
  });

  it('falls back to Chat Completions when local provider does not support Responses API', async () => {
    queryMock.mockResolvedValue({
      rows: [
        row('http://localhost:5737/cuilinsu/settings/providers/compatible.ttl', 'http://localhost:5737/cuilinsu/settings/providers/compatible.ttl', 'https://vocab.xpod.dev/ai#baseUrl', 'https://compatible.example/v1'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#compatible', 'https://vocab.xpod.dev/credential#provider', 'http://localhost:5737/cuilinsu/settings/providers/compatible.ttl', 'iri'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#compatible', 'https://vocab.xpod.dev/credential#service', 'ai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#compatible', 'https://vocab.xpod.dev/credential#status', 'active'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#compatible', 'https://vocab.xpod.dev/credential#apiKey', 'sk-compatible'),
      ],
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://compatible.example/v1/responses') {
        return new Response('responses endpoint not found', { status: 404 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'fallback pong' } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as any);

    const response = await callLocalChatRoute({
      chatId: 'chat-1',
      threadId: 'thread-1',
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
      content: '请只回复 pong',
      provider: 'compatible',
      model: 'compatible-model',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).assistantMessage.content).toBe('fallback pong');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://compatible.example/v1/responses',
      'https://compatible.example/v1/chat/completions',
    ]);
  });

  it('fails over when the primary credential times out', async () => {
    queryMock.mockResolvedValue({
      rows: [
        row('http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'https://vocab.xpod.dev/ai#routingPolicy', 'failover'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#provider', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'iri'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#service', 'ai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#status', 'active'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#apiKey', 'sk-main'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#baseUrl', 'https://slow.example/v1'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#timeoutMs', '1'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#main', 'https://vocab.xpod.dev/credential#isDefault', 'true'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#backup', 'https://vocab.xpod.dev/credential#provider', 'http://localhost:5737/cuilinsu/settings/providers/openai-main.ttl', 'iri'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#backup', 'https://vocab.xpod.dev/credential#service', 'ai'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#backup', 'https://vocab.xpod.dev/credential#status', 'active'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#backup', 'https://vocab.xpod.dev/credential#apiKey', 'sk-backup'),
        row('http://localhost:5737/cuilinsu/settings/credentials.ttl', 'http://localhost:5737/cuilinsu/settings/credentials.ttl#backup', 'https://vocab.xpod.dev/credential#baseUrl', 'https://backup.example/v1'),
      ],
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === 'https://slow.example/v1/responses') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ output_text: 'backup pong' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as any);

    const response = await callLocalChatRoute({
      chatId: 'chat-1',
      threadId: 'thread-1',
      webId: 'http://localhost:5737/cuilinsu/profile/card#me',
      content: '请只回复 pong',
      provider: 'openai-main',
      model: 'gpt-5.5',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).assistantMessage.content).toBe('backup pong');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://slow.example/v1/responses',
      'https://backup.example/v1/responses',
    ]);
  });
});

function row(
  graph: string,
  subject: string,
  predicate: string,
  value: string,
  kind: 'text' | 'iri' | 'literal' = 'text',
) {
  return {
    graph,
    subject,
    predicate,
    object_kind: kind,
    object_key: kind === 'iri' ? value : JSON.stringify(value),
    object_text: value,
    object: kind === 'iri' ? value : JSON.stringify(value),
  };
}

async function callLocalChatRoute(body: Record<string, unknown>): Promise<{ statusCode: number; body: string }> {
  let handler: any;
  const server = {
    get: vi.fn(),
    post: vi.fn((_path, registeredHandler) => {
      handler = registeredHandler;
    }),
  };
  registerLinxLocalChatRoutes(server as any);

  const request = Readable.from([JSON.stringify(body)]) as any;
  request.headers = {};
  request.auth = {
    type: 'solid',
    webId: typeof body.authWebId === 'string'
      ? body.authWebId
      : typeof body.webId === 'string'
        ? body.webId
        : 'http://localhost:5737/cuilinsu/profile/card#me',
  };

  const response: any = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    flushHeaders() {},
    write(chunk: string) {
      this.body += chunk;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
    },
  };

  await handler(request, response, {});
  return { statusCode: response.statusCode, body: response.body };
}
