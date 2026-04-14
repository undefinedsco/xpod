import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { NodeTokenAuthenticator } from '../../../src/api/auth/NodeTokenAuthenticator';

describe('NodeTokenAuthenticator', () => {
  const repository = {
    getNodeSecret: vi.fn(),
    matchesToken: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts raw bearer node tokens when x-node-id is present', async () => {
    repository.getNodeSecret.mockResolvedValue({
      tokenHash: 'hash',
      accountId: 'account-1',
    });
    repository.matchesToken.mockReturnValue(true);

    const authenticator = new NodeTokenAuthenticator({ repository: repository as any });
    const request = {
      headers: {
        authorization: 'Bearer raw-node-token',
        'x-node-id': 'node-1',
      },
    } as unknown as IncomingMessage;

    expect(authenticator.canAuthenticate(request)).toBe(true);

    const result = await authenticator.authenticate(request);
    expect(result).toEqual({
      success: true,
      context: {
        type: 'node',
        nodeId: 'node-1',
        accountId: 'account-1',
      },
    });
    expect(repository.matchesToken).toHaveBeenCalledWith('hash', 'raw-node-token');
  });

  it('still supports legacy bearer username:secret tokens', async () => {
    repository.getNodeSecret.mockResolvedValue({
      tokenHash: 'hash',
      accountId: 'account-1',
    });
    repository.matchesToken.mockReturnValue(true);

    const authenticator = new NodeTokenAuthenticator({ repository: repository as any });
    const request = {
      headers: {
        authorization: 'Bearer alice:legacy-secret',
        'x-node-id': 'node-1',
      },
    } as unknown as IncomingMessage;

    const result = await authenticator.authenticate(request);
    expect(result.success).toBe(true);
    expect(repository.matchesToken).toHaveBeenCalledWith('hash', 'legacy-secret');
  });
});
