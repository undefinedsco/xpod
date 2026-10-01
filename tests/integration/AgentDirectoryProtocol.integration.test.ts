import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptLiveDirectory } from '../../scripts/accept-live-agent-directory';
import { AgentDirectoryClient } from '../../src/agent-directory/client/AgentDirectoryClient';
import { XpodTestStack } from '../helpers/XpodTestStack';
import { loginWithClientCredentials, setupAccount, type AccountSetup, type ClientCredentialsSolidSession } from './helpers/solidAccount';

const integration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
// Only the full integration launcher supplies this isolated cloud runtime. Never use a public default.
const cloudUrl = process.env.XPOD_AGENT_DIRECTORY_TEST_CLOUD_URL;

for (const mode of ['local', 'cloud'] as const) {
  describe.skipIf(!integration || (mode === 'cloud' && !cloudUrl))(`Agent directory ${mode} candidate Gateway protocol`, () => {
    const stack = new XpodTestStack();
    let runtimeRoot: string | undefined;
    let baseUrl: string;
    let account: AccountSetup;
    let session: ClientCredentialsSolidSession;
    let privateRoot: string;

    beforeAll(async () => {
      if (mode === 'local') {
        await mkdir(path.resolve('.test-data/agent-directory-protocol'), { recursive: true });
        runtimeRoot = await mkdtemp(path.resolve('.test-data/agent-directory-protocol/local-'));
        // Actual CSS/API/Gateway and file storage; the shared helper's QLever process is a fixture.
        await stack.start('local', {
          transport: 'port', open: false, apiOpen: false, logLevel: 'error', runtimeRoot,
        });
        baseUrl = stack.baseUrl;
      } else {
        baseUrl = cloudUrl!;
      }
      const response = await fetch(new URL('/service/status', baseUrl));
      expect(response.status).toBe(200);
      const services = await response.json() as { name: string; status: string }[];
      expect(services).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'css', status: 'running' }),
        expect.objectContaining({ name: 'api', status: 'running' }),
      ]));
      const created = await setupAccount(baseUrl, `directory-${mode}`);
      expect(created, 'Candidate account/Pod creation must succeed').not.toBeNull();
      account = created!;
      session = await loginWithClientCredentials(account);
      expect(session.info.webId).toBe(account.webId);
      // A fresh Pod can expose its root/profile publicly. Restrict a child container explicitly.
      privateRoot = new URL(`private-directory-${randomUUID()}/`, account.podUrl).href;
      expect((await session.fetch(privateRoot, {
        method: 'PUT', headers: { 'Content-Type': 'text/turtle', 'If-None-Match': '*',
          Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '',
      })).ok).toBe(true);
      expect((await session.fetch(`${privateRoot}.acr`, {
        method: 'PUT', headers: { 'Content-Type': 'text/turtle', 'If-None-Match': '*' },
        body: `@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n@prefix acp: <http://www.w3.org/ns/solid/acp#>.\n<#acr> a acp:AccessControlResource; acp:resource <${privateRoot}>; acp:accessControl <#owner>; acp:memberAccessControl <#owner>.\n<#owner> a acp:AccessControl; acp:apply [ a acp:Policy; acp:allow acl:Read, acl:Write, acl:Append, acl:Control; acp:anyOf [ a acp:Matcher; acp:agent <${account.webId}> ] ].`,
      })).ok).toBe(true);
    }, 120_000);

    afterAll(async () => {
      await stack.stop();
      if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
    }, 60_000);

    const version = async (url: string): Promise<string> => {
      const response = await session.fetch(url, { method: 'HEAD' });
      expect(response.status).toBe(200);
      const etag = response.headers.get('etag');
      expect(etag, 'Mutation baselines require a strong ETag').toMatch(/^"[^"\r\n]*"$/);
      return etag!;
    };

    it('requires real identity and rejects another account at the directory boundary', async () => {
      const url = new URL('/-/agent-directory/list', baseUrl);
      url.searchParams.set('root', privateRoot);
      expect([401, 403]).toContain((await fetch(privateRoot)).status);
      const anonymous = await fetch(url);
      expect([401, 403]).toContain(anonymous.status);
      const other = await setupAccount(baseUrl, `directory-other-${mode}`);
      expect(other).not.toBeNull();
      const otherSession = await loginWithClientCredentials(other!);
      const denied = await otherSession.fetch(url);
      expect([401, 403]).toContain(denied.status);
      const client = new AgentDirectoryClient({ baseUrl, request: (target, init) => session.fetch(target, init) });
      await expect(client.list({ root: privateRoot })).resolves.toMatchObject({ root: privateRoot, complete: true });
    }, 120_000);

    it('selects the directory handler when the Gateway appends to a forwarded proto chain', async () => {
      const forwardedProto = new URL(baseUrl).protocol.replace(':', '');
      const withForwarded = (init?: RequestInit): RequestInit => {
        const headers = new Headers(init?.headers);
        // An upstream client/edge already supplied the authoritative scheme; the
        // Gateway's xfwd:true proxy then appends the downstream scheme, so CSS
        // observes "<proto>,<proto>" instead of a single value.
        headers.set('x-forwarded-proto', forwardedProto);
        return { ...init, headers };
      };
      const fileName = `forwarded-proto-${randomUUID()}.txt`;
      const file = new URL(fileName, privateRoot).href;
      expect((await session.fetch(file, {
        method: 'PUT', headers: { 'If-None-Match': '*', 'Content-Type': 'text/plain' },
        body: 'forwarded-probe-content',
      })).ok).toBe(true);

      const client = new AgentDirectoryClient({
        baseUrl,
        request: (target, init) => session.fetch(target, withForwarded(init)),
      });
      const listed = await client.list({ root: privateRoot });
      expect(listed.entries.map((entry) => entry.path)).toContain(fileName);
      expect(listed.complete).toBe(true);
      const searched = await client.search({ root: privateRoot, query: 'forwarded-probe-content' });
      expect(searched.matches.some((match) => match.path === fileName)).toBe(true);

      // Authentication/authorization boundaries must not be relaxed by the
      // forwarded header: anonymous and another account stay rejected.
      const listUrl = new URL('/-/agent-directory/list', baseUrl);
      listUrl.searchParams.set('root', privateRoot);
      const anonymous = await fetch(listUrl, { headers: { 'x-forwarded-proto': forwardedProto } });
      expect([401, 403]).toContain(anonymous.status);
      const other = await setupAccount(baseUrl, `directory-forwarded-other-${mode}`);
      expect(other).not.toBeNull();
      const otherSession = await loginWithClientCredentials(other!);
      const denied = await otherSession.fetch(listUrl, withForwarded());
      expect([401, 403]).toContain(denied.status);
    }, 120_000);

    it('runs Range, metadata/search and conditional file writes through production components', async () => {
      const report = await acceptLiveDirectory({
        gateway: baseUrl, podRoot: privateRoot, write: true,
        discover: (url, init) => fetch(url, init),
        authenticate: async () => ({ webId: account.webId, request: (url, init) => session.fetch(url, init) }),
      });
      expect(report.status, JSON.stringify(report.checks)).toBe('pass');
      expect(report).toMatchObject({ status: 'pass', phase: 'pod-http-contract', cleanup: { status: 'pass', retained: [] }, mount: 'not-run' });
      expect(report.checks).toEqual(expect.arrayContaining([
        { name: 'range-read', status: 'pass' },
        { name: 'directory-list-and-search', status: 'pass' },
        { name: 'stale-write-and-delete-conflict', status: 'pass' },
      ]));
    }, 120_000);

    it('completes a collaborator SPARQL update through the default ACP reader without self-locking', async () => {
      const collaborator = await setupAccount(baseUrl, `directory-collaborator-${mode}`);
      expect(collaborator).not.toBeNull();
      const collaboratorSession = await loginWithClientCredentials(collaborator!);
      const directory = new URL(`shared-rdf-${randomUUID()}/`, privateRoot).href;
      const document = new URL('data.ttl', directory).href;
      expect((await session.fetch(directory, {
        method: 'PUT', headers: { 'Content-Type': 'text/turtle', 'If-None-Match': '*',
          Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '',
      })).ok).toBe(true);
      expect((await session.fetch(`${directory}.acr`, {
        method: 'PUT', headers: { 'Content-Type': 'text/turtle', 'If-None-Match': '*' },
        body: `@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n@prefix acp: <http://www.w3.org/ns/solid/acp#>.\n<#acr> a acp:AccessControlResource; acp:resource <${directory}>; acp:accessControl <#shared>; acp:memberAccessControl <#shared>.\n<#shared> a acp:AccessControl; acp:apply [ a acp:Policy; acp:allow acl:Read, acl:Write, acl:Append; acp:anyOf [ a acp:Matcher; acp:agent <${collaborator!.webId}> ] ].`,
      })).ok).toBe(true);
      expect((await session.fetch(document, {
        method: 'PUT', headers: { 'Content-Type': 'text/turtle', 'If-None-Match': '*' },
        body: `<${document}#initial> <https://example.test/value> "initial".`,
      })).ok).toBe(true);
      const authorizedRead = await collaboratorSession.fetch(document);
      expect(authorizedRead.status, await authorizedRead.text()).toBe(200);
      const response = await collaboratorSession.fetch(new URL('-/sparql', directory).href, {
        method: 'POST', headers: { 'Content-Type': 'application/sparql-update' },
        body: `INSERT DATA { GRAPH <${document}> { <${document}#s> <https://example.test/value> "collaborator" } }`,
        signal: AbortSignal.timeout(15_000),
      });
      expect(response.status, await response.text()).toBe(204);
      const read = await collaboratorSession.fetch(document, { headers: { Accept: 'text/turtle' } });
      expect(read.status).toBe(200);
      expect(await read.text()).toContain('collaborator');
    }, 120_000);

    it('rejects a stale file write after a rapid update from another session', async () => {
      const file = new URL(`rapid-version-${randomUUID()}.txt`, privateRoot).href;
      expect((await session.fetch(file, {
        method: 'PUT', headers: { 'If-None-Match': '*', 'Content-Type': 'text/plain' }, body: 'first version',
      })).ok).toBe(true);
      const firstVersion = await version(file);
      const otherSession = await loginWithClientCredentials(account);
      expect((await otherSession.fetch(file, {
        method: 'PUT', headers: { 'If-Match': firstVersion, 'Content-Type': 'text/plain' }, body: 'external version',
      })).ok).toBe(true);
      const currentVersion = await version(file);
      const staleWrite = await session.fetch(file, {
        method: 'PUT', headers: { 'If-Match': firstVersion, 'Content-Type': 'text/plain' }, body: 'MUST_NOT_OVERWRITE',
      });
      expect(staleWrite.status, `baseline=${firstVersion}, current=${currentVersion}`).toBe(412);
      expect(currentVersion).not.toBe(firstVersion);
      expect(await (await otherSession.fetch(file)).text()).toBe('external version');
      expect((await otherSession.fetch(file, { method: 'DELETE', headers: { 'If-Match': currentVersion } })).ok).toBe(true);
    }, 120_000);

    it('invalidates an empty-container baseline when another session adds a child', async () => {
      const directory = new URL(`directory-version-${randomUUID()}/`, privateRoot).href;
      const child = new URL('child.txt', directory).href;
      const created = await session.fetch(directory, {
        method: 'PUT', headers: {
          'If-None-Match': '*', 'Content-Type': 'text/turtle',
          Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        }, body: '',
      });
      expect(created.ok).toBe(true);
      const emptyVersion = await version(directory);
      const otherSession = await loginWithClientCredentials(account);
      const write = await otherSession.fetch(child, {
        method: 'PUT', headers: { 'If-None-Match': '*', 'Content-Type': 'text/plain' }, body: 'concurrent child',
      });
      expect(write.ok).toBe(true);
      const occupiedVersion = await version(directory);
      expect(occupiedVersion).not.toBe(emptyVersion);
      const deletion = await session.fetch(directory, { method: 'DELETE', headers: { 'If-Match': emptyVersion } });
      expect([409, 412]).toContain(deletion.status);
      const retained = await otherSession.fetch(child);
      expect(retained.status).toBe(200);
      expect(await retained.text()).toBe('concurrent child');
      const removed = await otherSession.fetch(child, { method: 'DELETE', headers: { 'If-Match': await version(child) } });
      expect(removed.ok).toBe(true);
      const nowEmpty = await version(directory);
      expect(nowEmpty).not.toBe(occupiedVersion);
      const client = new AgentDirectoryClient({ baseUrl, request: (url, init) => session.fetch(url, init) });
      expect((await client.listAll({ root: directory })).entries).toEqual([]);
      expect((await session.fetch(directory, { method: 'DELETE', headers: { 'If-Match': nowEmpty } })).ok).toBe(true);
      expect((await session.fetch(directory, { method: 'HEAD' })).status).toBe(404);
    }, 120_000);
  });
}
