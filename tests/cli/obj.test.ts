import { credentialDescriptor } from '@undefineds.co/models';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  describeSchemaDescriptor,
  buildDescriptorDeleteSparql,
  buildDescriptorLinkSparql,
  buildDescriptorObjectQuery,
  buildDescriptorPatchSparql,
  buildDescriptorUpsertSparql,
  descriptorUpsertPlanItem,
  extractReservedWhereSelectors,
  executeRows,
  getObjLocalOutboxPath,
  listSchemaDescriptors,
  mutationItemsResultCode,
  redactDescriptorObject,
  resolveObjMutationContext,
  serializeSchemaDescriptor,
} from '../../src/cli/commands/obj';

describe('obj command helpers', () => {
  const discoveryDescriptor = {
    ...credentialDescriptor,
    uri: 'https://undefineds.co/ns#Idea',
    class: 'https://undefineds.co/ns#Idea',
    resourceKind: 'idea',
    storage: {
      base: '/.data/ideas/',
      resourceIdPattern: '{id}',
    },
    aliases: [ 'Idea' ],
    domains: [ 'capture' ],
    relationFields: [ 'document' ],
    idSemantics: { explicitId: true },
    documentPathPolicy: {
      field: 'document',
      kind: 'document',
      contentType: 'text/markdown',
      defaultPathPattern: 'projects/{project}/ideas/{slug}.md',
      pathInputs: [ 'project', 'slug' ],
    },
    exampleInput: {
      match: { id: '2026/06/30.ttl#idea_1' },
      set: { summary: 'Durable memory' },
    },
    fields: {
      ...credentialDescriptor.fields,
      id: {
        type: 'string' as const,
        predicate: 'https://undefineds.co/ns#id',
        required: true,
      },
      summary: {
        type: 'string' as const,
        predicate: 'http://purl.org/dc/terms/abstract',
        required: true,
      },
      document: {
        type: 'uri' as const,
        predicate: 'http://purl.org/dc/terms/source',
      },
    },
    uniqueBy: [ 'id' ],
    writableFields: [ 'summary', 'document' ],
  };

  it('serializes model descriptors with AI discovery metadata intact', () => {
    expect(serializeSchemaDescriptor(discoveryDescriptor)).toMatchObject({
      schema: 'https://undefineds.co/ns#Idea',
      alias: 'Idea',
      aliases: [ 'Idea' ],
      domains: [ 'capture' ],
      resourceKind: 'idea',
      idSemantics: { explicitId: true },
      relationFields: [ 'document' ],
      documentPathPolicy: {
        field: 'document',
        defaultPathPattern: 'projects/{project}/ideas/{slug}.md',
      },
      exampleInput: {
        match: { id: '2026/06/30.ttl#idea_1' },
        set: { summary: 'Durable memory' },
      },
      fields: expect.objectContaining({
        summary: expect.objectContaining({ required: true }),
        document: expect.objectContaining({ type: 'uri' }),
      }),
    });
  });

  it('lists and describes descriptors by domain and alias', () => {
    const descriptors = [ credentialDescriptor, discoveryDescriptor ];

    expect(listSchemaDescriptors({ domain: 'capture' }, descriptors).map((item) => item.schema))
      .toEqual([ 'https://undefineds.co/ns#Idea' ]);

    expect(describeSchemaDescriptor('Idea', descriptors)).toMatchObject({
      schema: 'https://undefineds.co/ns#Idea',
      alias: 'Idea',
    });
  });

  it('includes document path policy in descriptor upsert dry-run plan items', () => {
    expect(descriptorUpsertPlanItem({
      descriptor: discoveryDescriptor,
      index: 0,
      commit: false,
      podRoot: 'https://pod.example/alice/',
      row: {
        schema: discoveryDescriptor.uri,
        match: { id: '2026/06/30.ttl#idea_1' },
        set: {
          summary: 'Durable memory',
          document: 'https://pod.example/alice/projects/linx-cli/ideas/durable-memory.md',
        },
      },
    })).toMatchObject({
      index: 0,
      ok: true,
      code: 'plan_ready',
      subject: 'https://pod.example/alice/.data/ideas/2026/06/30.ttl#idea_1',
      documentPathPolicy: {
        field: 'document',
        defaultPathPattern: 'projects/{project}/ideas/{slug}.md',
      },
    });
  });

  it('allows unauthenticated descriptor dry-run planning without granting commit authority', async () => {
    const previousSolidHome = process.env.SOLID_HOME;
    process.env.SOLID_HOME = mkdtempSync(join(tmpdir(), 'xpod-obj-noauth-'));
    try {
      const context = await resolveObjMutationContext({ json: true }, false);

      expect(context).toMatchObject({
        planningOnly: true,
        webId: 'urn:xpod:unauthenticated',
        podRoot: 'https://pod.local/',
      });

      const commitContext = await resolveObjMutationContext({ json: true }, true);
      expect(commitContext).toMatchObject({
        pendingOnly: true,
        webId: 'urn:xpod:unauthenticated',
        podRoot: 'https://pod.local/',
      });
    } finally {
      if (previousSolidHome === undefined) {
        delete process.env.SOLID_HOME;
      } else {
        process.env.SOLID_HOME = previousSolidHome;
      }
    }
  });

  it('writes unauthenticated commit attempts to the local xpod obj outbox', async () => {
    const previousSolidHome = process.env.SOLID_HOME;
    process.env.SOLID_HOME = mkdtempSync(join(tmpdir(), 'xpod-obj-outbox-'));
    try {
      const items = await executeRows({
        argv: { json: true },
        defaultSchema: credentialDescriptor.uri,
        commit: true,
        rows: [
          {
            match: {
              service: 'ai',
              providerId: 'demo',
              secretType: 'api-key',
            },
            set: {
              label: 'Demo',
              status: 'active',
            },
          },
        ],
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        ok: true,
        code: 'pending_local',
        pendingLocal: true,
        subject: 'https://pod.local/settings/credentials.ttl#ai-demo-api-key',
      });
      expect(existsSync(getObjLocalOutboxPath())).toBe(true);
      const lines = readFileSync(getObjLocalOutboxPath(), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry).toMatchObject({
        kind: 'xpod.obj.mutation',
        status: 'pending',
        row: {
          schema: credentialDescriptor.uri,
          match: {
            service: 'ai',
            providerId: 'demo',
            secretType: 'api-key',
          },
        },
        item: {
          code: 'plan_ready',
          subject: 'https://pod.local/settings/credentials.ttl#ai-demo-api-key',
        },
      });
    } finally {
      if (previousSolidHome === undefined) {
        delete process.env.SOLID_HOME;
      } else {
        process.env.SOLID_HOME = previousSolidHome;
      }
    }
  });

  it('summarizes pending local mutation batches without claiming committed', () => {
    expect(mutationItemsResultCode([
      { index: 0, ok: true, code: 'pending_local' },
    ], true)).toBe('pending_local');

    expect(mutationItemsResultCode([
      { index: 0, ok: true, code: 'committed' },
    ], true)).toBe('committed');

    expect(mutationItemsResultCode([
      { index: 0, ok: false, code: 'invalid_set_fields' },
    ], true)).toBe('partial_failure');
  });

  it('accepts stdin marker after --from as a separate argv token', () => {
    const solidHome = mkdtempSync(join(tmpdir(), 'xpod-obj-from-stdin-'));
    const input = `${JSON.stringify({
      match: {
        service: 'ai',
        providerId: 'demo',
        secretType: 'api-key',
      },
      set: {
        label: 'Demo',
        status: 'active',
      },
    })}\n`;
    const result = spawnSync('bun', [
      'src/cli/index.ts',
      'obj',
      'upsert',
      '--schema',
      'Credential',
      '--from',
      '-',
      '--dry-run',
      '--json',
    ], {
      cwd: process.cwd(),
      input,
      encoding: 'utf-8',
      env: {
        ...process.env,
        SOLID_HOME: solidHome,
      },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: true,
      code: 'plan_ready',
      items: [
        {
          ok: true,
          subject: 'https://pod.local/settings/credentials.ttl#ai-demo-api-key',
        },
      ],
    });
  });

  it('redacts descriptor fields marked secret', () => {
    expect(redactDescriptorObject(credentialDescriptor, {
      service: 'ai',
      providerId: 'openai',
      apiKey: 'sk-secret',
    })).toEqual({
      service: 'ai',
      providerId: 'openai',
      apiKey: '[redacted]',
    });
  });

  it('builds descriptor-backed upsert SPARQL without private predicates', () => {
    const sparql = buildDescriptorUpsertSparql(
      credentialDescriptor,
      'https://pod.example/alice/settings/credentials.ttl#ai-openai-api-key',
      {
        schema: credentialDescriptor.uri,
        match: {
          service: 'ai',
          providerId: 'openai',
          secretType: 'api-key',
        },
        set: {
          label: 'OpenAI',
          apiKey: 'sk-secret',
          status: 'active',
        },
      },
    );

    expect(sparql).toContain(`<${credentialDescriptor.class}>`);
    expect(sparql).toContain(`<${credentialDescriptor.fields.providerId.predicate}> "openai"`);
    expect(sparql).toContain(`<${credentialDescriptor.fields.apiKey.predicate}> "sk-secret"`);
    expect(sparql).not.toContain('udfs:');
  });

  it('builds descriptor-backed patch SPARQL only for writable descriptor fields', () => {
    const sparql = buildDescriptorPatchSparql(
      credentialDescriptor,
      'https://pod.example/alice/settings/credentials.ttl#ai-openai-api-key',
      { label: 'OpenAI', status: 'active' },
    );

    expect(sparql).toContain('?old_label');
    expect(sparql).toContain(`<${credentialDescriptor.fields.label.predicate}> "OpenAI"`);
    expect(sparql).toContain(`<${credentialDescriptor.fields.status.predicate}> "active"`);
  });

  it('builds descriptor-backed relation and delete SPARQL without inventing semantics', () => {
    expect(buildDescriptorLinkSparql(
      'https://pod.example/alice/settings/credentials.ttl#cred',
      'https://example.com/rel',
      'https://pod.example/alice/target#x',
    )).toContain('<https://example.com/rel> <https://pod.example/alice/target#x>');

    expect(buildDescriptorDeleteSparql('https://pod.example/alice/settings/credentials.ttl#cred'))
      .toContain('<https://pod.example/alice/settings/credentials.ttl#cred> ?p ?o');
  });

  it('builds object list queries from descriptor fields and filters', () => {
    const query = buildDescriptorObjectQuery({
      descriptor: credentialDescriptor,
      where: { status: 'active' },
      relations: {},
      limit: 25,
      includeMetadata: true,
    });

    expect(query).toContain(`?subject a <${credentialDescriptor.class}>`);
    expect(query).toContain(`<${credentialDescriptor.fields.status.predicate}> "active"`);
    expect(query).toContain('LIMIT 25');
  });

  it('keeps reserved selector fields out of descriptor field filters', () => {
    expect(extractReservedWhereSelectors({
      subject: 'settings/credentials.ttl#cred',
      resource: 'settings/credentials.ttl',
      status: 'active',
    })).toEqual({
      subject: 'settings/credentials.ttl#cred',
      resource: 'settings/credentials.ttl',
      where: { status: 'active' },
    });
  });

  it('rejects non-string reserved selector fields', () => {
    expect(() => extractReservedWhereSelectors({ subject: 123 }))
      .toThrow('Reserved selector field "subject" must be a string.');
  });
});
