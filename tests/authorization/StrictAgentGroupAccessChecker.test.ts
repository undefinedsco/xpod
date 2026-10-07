import { describe, expect, it, vi } from 'vitest';
import { AgentGroupAccessChecker } from '@solidlab/policy-engine';
import { createServer } from 'node:http';
import { DataFactory } from 'n3';
import { StrictAgentGroupAccessChecker } from '../../src/authorization/StrictAgentGroupAccessChecker';
import {
  captureAuthorityDependency,
  collectAuthorityDependencies,
  newAuthoritySnapshotState,
} from '../../src/storage/AuthoritySnapshotContext';

const GROUP = 'https://groups.example/members/card#this';
const auth = {
  id: { termType: 'NamedNode', value: 'https://pod.example/.acl#group' },
  accessTo: [], default: [], agent: [], agentClass: [],
  agentGroup: [ { termType: 'NamedNode', value: GROUP } ],
  mode: [],
} as never;
const args = { auth, credentials: { agent: 'https://alice.example/card#me' } } as never;

describe('StrictAgentGroupAccessChecker', () => {
  it('fails closed for a group grant inside a strict authority attempt, even when tracked', async() => {
    const checker = new StrictAgentGroupAccessChecker();
    const state = newAuthoritySnapshotState();
    const result = await collectAuthorityDependencies(state, async() => {
      // A dependency-map entry does not prove the fetched membership data was frozen.
      captureAuthorityDependency(GROUP, GROUP);
      return await checker.handle(args);
    });
    expect(result.agentGroup?.success).toBe(false);
    expect(result.agentGroup?.reason).toContain('authority-tracked');
  });

  it('delegates to the ordinary checker outside a strict authority attempt', async() => {
    const spy = vi.spyOn(AgentGroupAccessChecker.prototype, 'handle')
      .mockResolvedValue({ auth, agent: { success: true } } as never);
    try {
      const checker = new StrictAgentGroupAccessChecker();
      const result = await checker.handle(args);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.agent?.success).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses real ordinary group membership and refuses an unfrozen group under its own validation key', async() => {
    let requests = 0;
    let group = '';
    const webId = 'https://alice.example/profile/card#me';
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { 'Content-Type': 'text/turtle' });
      response.end(`<${group}> <http://www.w3.org/2006/vcard/ns#hasMember> <${webId}>.`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Group fixture has no TCP address');
      group = `http://127.0.0.1:${address.port}/group.ttl#members`;
      const input = { auth: {
        id: DataFactory.namedNode('https://pod.example/.acl#grant'),
        accessTo: [], default: [], agent: [ DataFactory.namedNode(webId) ], agentClass: [],
        agentGroup: [ DataFactory.namedNode(group) ], mode: [],
      }, credentials: { agent: webId } } as never;
      const checker = new StrictAgentGroupAccessChecker();
      const ordinary = await checker.handle(input);
      expect(ordinary.agentGroup?.success).toBe(true);
      expect(requests).toBe(1);
      const strict = await collectAuthorityDependencies(newAuthoritySnapshotState(), () => checker.handle(input));
      expect(strict.agentGroup?.success).toBe(false);
      expect(strict.agent, 'a group checker must not replace direct-agent validation').toBeUndefined();
      expect(requests, 'strict group checks must not fetch unfrozen membership').toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
