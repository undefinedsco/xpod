import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PodSolidFsHydrator, SolidFsConflictError, type SolidFsChange, type SolidFsManifest } from '../../src/solidfs';

describe('PodSolidFsHydrator', () => {
  it('GETs object resources into the materialized workspace and records the authority version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-pod-hydrate-'));
    const targetPath = path.join(root, 'assets', 'image.bin');
    const fetchMock = vi.fn().mockResolvedValue(new Response('remote object\n', {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        ETag: '"etag-before"',
      },
    }));
    const hydrator = new PodSolidFsHydrator({ fetch: fetchMock as any });

    try {
      const result = await hydrator.hydrate({
        path: 'assets/image.bin',
        targetPath,
        workspace: manifestFor('https://pod.example/alice/projects/demo/'),
        context: accessTokenContext(),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://pod.example/alice/projects/demo/assets/image.bin');
      expect(fetchMock.mock.calls[0][1].method).toBe('GET');
      expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer token-123');
      expect(result).toEqual({
        contentType: 'application/octet-stream',
        sourceVersion: '"etag-before"',
      });
      await expect(readFile(targetPath, 'utf8')).resolves.toBe('remote object\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('PUTs dirty hydrated objects with If-Match and returns the new authority version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-pod-commit-'));
    const sourcePath = path.join(root, 'document.bin');
    await writeFile(sourcePath, 'updated object\n', 'utf8');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { ETag: '"etag-after"' },
    }));
    const hydrator = new PodSolidFsHydrator({ fetch: fetchMock as any });

    try {
      const result = await hydrator.commit({
        change: objectChange('document.bin', sourcePath, 'updated', '"etag-before"'),
        workspace: manifestFor('https://pod.example/alice/projects/demo/'),
        context: accessTokenContext(),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://pod.example/alice/projects/demo/document.bin');
      expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
      expect(fetchMock.mock.calls[0][1].headers.get('If-Match')).toBe('"etag-before"');
      expect(fetchMock.mock.calls[0][1].headers.get('Content-Type')).toBe('application/octet-stream');
      expect(result).toEqual({ sourceVersion: '"etag-after"' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses a change IRI when committing hydrated objects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-pod-commit-resource-'));
    const sourcePath = path.join(root, 'document.bin');
    await writeFile(sourcePath, 'updated object\n', 'utf8');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const hydrator = new PodSolidFsHydrator({ fetch: fetchMock as any });

    try {
      await hydrator.commit({
        change: {
          ...objectChange('ignored.bin', sourcePath, 'updated', '"etag-before"'),
        resource: 'https://pod.example/alice/objects/document.bin',
        },
        workspace: manifestFor('https://pod.example/alice/projects/demo/'),
        context: accessTokenContext(),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://pod.example/alice/objects/document.bin');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it('maps 409 and 412 object commits to SolidFS conflicts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-pod-conflict-'));
    const sourcePath = path.join(root, 'document.bin');
    await writeFile(sourcePath, 'updated object\n', 'utf8');
    const fetchMock = vi.fn().mockResolvedValue(new Response('precondition failed', {
      status: 412,
      headers: { ETag: '"etag-current"' },
    }));
    const hydrator = new PodSolidFsHydrator({ fetch: fetchMock as any });

    try {
      const promise = hydrator.commit({
        change: objectChange('document.bin', sourcePath, 'updated', '"etag-before"'),
        workspace: manifestFor('https://pod.example/alice/projects/demo/'),
        context: accessTokenContext(),
      });
      await expect(promise).rejects.toBeInstanceOf(SolidFsConflictError);
      await promise.catch((error: SolidFsConflictError) => {
        expect(error.conflicts).toMatchObject([{
          path: 'document.bin',
          expectedVersion: '"etag-before"',
          actualVersion: '"etag-current"',
        }]);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exchanges client credentials before hydrating when no access token is present', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-pod-hydrate-credentials-'));
    const targetPath = path.join(root, 'asset.bin');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'token-from-client-credentials',
        token_type: 'Bearer',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('remote object\n', {
        status: 200,
        headers: { ETag: '"etag-before"' },
      }));
    const hydrator = new PodSolidFsHydrator({
      fetch: fetchMock as any,
      tokenEndpoint: 'https://pod.example/.oidc/token',
    });

    try {
      await hydrator.hydrate({
        path: 'asset.bin',
        targetPath,
        workspace: manifestFor('https://pod.example/alice/projects/demo/'),
        context: {
          auth: {
            type: 'solid',
            webId: 'https://pod.example/alice/profile/card#me',
            clientId: 'client-id',
            clientSecret: 'client-secret',
          },
        },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe('https://pod.example/.oidc/token');
      expect(fetchMock.mock.calls[0][1].method).toBe('POST');
      expect(fetchMock.mock.calls[1][1].headers.get('Authorization')).toBe('Bearer token-from-client-credentials');
      await expect(readFile(targetPath, 'utf8')).resolves.toBe('remote object\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function objectChange(pathValue: string, sourcePath: string, type: SolidFsChange['type'], sourceVersion?: string): SolidFsChange {
  return {
    path: pathValue,
        resource: `https://pod.example/alice/projects/demo/${pathValue}`,
    source: 'object',
    sourcePath,
    contentType: 'application/octet-stream',
    projection: 'hydrated-object',
    type,
    sourceVersion,
  };
}

function manifestFor(workspace: string): SolidFsManifest {
  return {
    workspace,
    cwd: '/tmp/workspace',
    projection: 'hydrated-object',
    entries: [],
  };
}

function accessTokenContext(): Record<string, unknown> {
  return {
    auth: {
      type: 'solid',
      webId: 'https://pod.example/alice/profile/card#me',
      accessToken: 'token-123',
      tokenType: 'Bearer',
    },
  };
}
