import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PodSolidFsSyncer, resolvePodResourceUrl } from '../../src/solidfs';
import type { SolidFsChange, SolidFsManifest } from '../../src/solidfs';

describe('PodSolidFsSyncer', () => {
  it('resolves workspace-relative file paths to Pod resource URLs', () => {
    const change = rdfChange('notes/data.ttl', '/tmp/data.ttl', 'updated');
    const manifest = manifestFor('https://pod.example/alice/projects/demo/');

    expect(resolvePodResourceUrl(change, manifest)).toBe('https://pod.example/alice/projects/demo/notes/data.ttl');
  });

  it('uses a change IRI as the canonical Pod resource URL when present', () => {
    const change = {
      ...rdfChange('ignored/data.ttl', '/tmp/data.ttl', 'updated'),
        resource: 'https://pod.example/alice/.data/chat/default/index.ttl',
    };
    const manifest = manifestFor('https://pod.example/alice/projects/demo/');

    expect(resolvePodResourceUrl(change, manifest)).toBe('https://pod.example/alice/.data/chat/default/index.ttl');
  });

  it('PUTs changed RDF files through the authenticated Pod HTTP surface', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-pod-sync-'));
    const filePath = path.join(root, 'data.ttl');
    await writeFile(filePath, '<#me> <https://schema.org/name> "Alice" .\n', 'utf8');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const syncer = new PodSolidFsSyncer({ fetch: fetchMock as any });

    try {
      await syncer.sync(
        rdfChange('data.ttl', filePath, 'updated'),
        manifestFor('https://pod.example/alice/projects/demo/'),
        {
          auth: {
            type: 'solid',
            webId: 'https://pod.example/alice/profile/card#me',
            accessToken: 'token-123',
            tokenType: 'Bearer',
          },
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://pod.example/alice/projects/demo/data.ttl');
      expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
      expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer token-123');
      expect(fetchMock.mock.calls[0][1].headers.get('Content-Type')).toBe('text/turtle');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('PUTs standard RDF/XML files through the authenticated Pod HTTP surface', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-pod-rdfxml-sync-'));
    const filePath = path.join(root, 'ontology.owl');
    await writeFile(filePath, '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>', 'utf8');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const syncer = new PodSolidFsSyncer({ fetch: fetchMock as any });

    try {
      await syncer.sync(
        rdfChange('ontology.owl', filePath, 'updated', 'application/rdf+xml'),
        manifestFor('https://pod.example/alice/projects/demo/'),
        {
          auth: {
            type: 'solid',
            webId: 'https://pod.example/alice/profile/card#me',
            accessToken: 'token-123',
            tokenType: 'Bearer',
          },
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://pod.example/alice/projects/demo/ontology.owl');
      expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
      expect(fetchMock.mock.calls[0][1].headers.get('Content-Type')).toBe('application/rdf+xml');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('DELETEs removed RDF files with exchanged client-credentials tokens and ignores non-Pod workspaces', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'token-from-client-credentials',
        token_type: 'Bearer',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const syncer = new PodSolidFsSyncer({
      fetch: fetchMock as any,
      tokenEndpoint: 'https://pod.example/.oidc/token',
    });

    await syncer.sync(
      rdfChange('data.ttl', '/tmp/data.ttl', 'deleted'),
      manifestFor('https://pod.example/alice/projects/demo/'),
      {
        auth: {
          type: 'solid',
          webId: 'https://pod.example/alice/profile/card#me',
          clientId: 'client-id',
          clientSecret: 'client-secret',
        },
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://pod.example/.oidc/token');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
    expect(fetchMock.mock.calls[1][1].headers.get('Authorization')).toBe('Bearer token-from-client-credentials');

    await syncer.sync(
      rdfChange('data.ttl', '/tmp/data.ttl', 'updated'),
      manifestFor('file:///tmp/workspace/'),
      {
        auth: {
          type: 'solid',
          webId: 'https://pod.example/alice/profile/card#me',
          accessToken: 'token-123',
        },
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function rdfChange(
  pathValue: string,
  sourcePath: string,
  type: SolidFsChange['type'],
  contentType = 'text/turtle',
): SolidFsChange {
  return {
    path: pathValue,
    source: 'pod-http',
    sourcePath,
    contentType,
    projection: 'direct',
    type,
  };
}

function manifestFor(workspace: string): SolidFsManifest {
  return {
    workspace,
    cwd: '/tmp/workspace',
    projection: 'direct',
    entries: [],
  };
}
