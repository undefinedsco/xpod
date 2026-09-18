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
    repository.getNodeSecret.mockResolvedValue({ tokenHash: 'hash' });
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
      },
    });
    expect(repository.matchesToken).toHaveBeenCalledWith('hash', 'raw-node-token');
  });

  it('treats bearer node tokens as opaque credentials', async () => {
    repository.getNodeSecret.mockResolvedValue({ tokenHash: 'hash' });
    repository.matchesToken.mockReturnValue(true);

    const authenticator = new NodeTokenAuthenticator({ repository: repository as any });
    const request = {
      headers: {
        // This raw node token happens to decode into bytes containing a colon;
        // node auth must still verify the original opaque token string.
        authorization: 'Bearer bm90LXRoZS1ub2RlOmFjY2lkZW50YWwtc2VjcmV0',
        'x-node-id': 'node-1',
      },
    } as unknown as IncomingMessage;

    const result = await authenticator.authenticate(request);
    expect(result.success).toBe(true);
    expect(repository.matchesToken).toHaveBeenCalledWith('hash', 'bm90LXRoZS1ub2RlOmFjY2lkZW50YWwtc2VjcmV0');
  });

  it('accepts XpodNode credentials with matching tokens', async () => {
    repository.getNodeSecret.mockResolvedValue({ tokenHash: 'hash' });
    repository.matchesToken.mockReturnValue(true);

    const authenticator = new NodeTokenAuthenticator({ repository: repository as any });
    const request = {
      headers: { authorization: 'XpodNode node-1:secret-token' },
    } as unknown as IncomingMessage;

    expect(authenticator.canAuthenticate(request)).toBe(true);

    const result = await authenticator.authenticate(request);
    expect(result).toEqual({
      success: true,
      context: { type: 'node', nodeId: 'node-1' },
    });
    expect(repository.matchesToken).toHaveBeenCalledWith('hash', 'secret-token');
  });

  it('rejects unknown nodes instead of letting them through', async () => {
    repository.getNodeSecret.mockResolvedValue(undefined);

    const authenticator = new NodeTokenAuthenticator({ repository: repository as any });
    const request = {
      headers: { authorization: 'XpodNode unregistered-node:any-token' },
    } as unknown as IncomingMessage;

    const result = await authenticator.authenticate(request);
    expect(result).toEqual({ success: false, error: 'Unknown node' });
    expect(repository.matchesToken).not.toHaveBeenCalled();
  });

  it('rejects tokens that do not match the stored hash', async () => {
    repository.getNodeSecret.mockResolvedValue({ tokenHash: 'hash' });
    repository.matchesToken.mockReturnValue(false);

    const authenticator = new NodeTokenAuthenticator({ repository: repository as any });
    const request = {
      headers: { authorization: 'XpodNode node-1:wrong-token' },
    } as unknown as IncomingMessage;

    const result = await authenticator.authenticate(request);
    expect(result.success).toBe(false);
    expect(repository.matchesToken).toHaveBeenCalledWith('hash', 'wrong-token');
  });

  it('rejects malformed XpodNode credentials', async () => {
    const authenticator = new NodeTokenAuthenticator({ repository: repository as any });
    const request = {
      headers: { authorization: 'XpodNode no-colon-here' },
    } as unknown as IncomingMessage;

    const result = await authenticator.authenticate(request);
    expect(result.success).toBe(false);
    expect(repository.getNodeSecret).not.toHaveBeenCalled();
  });

  it('rejects when the node repository is unavailable', async () => {
    repository.getNodeSecret.mockRejectedValueOnce(new Error('database unavailable'));
    const authenticator = new NodeTokenAuthenticator({ repository: repository as any });
    const result = await authenticator.authenticate({
      headers: { authorization: 'XpodNode node-1:secret-token' },
    } as unknown as IncomingMessage);
    expect(result.success).toBe(false);
    expect(result.context).toBeUndefined();
    expect(repository.matchesToken).not.toHaveBeenCalled();
  });

  it('rejects empty bearer node tokens', async () => {
    const authenticator = new NodeTokenAuthenticator({ repository: repository as any });
    const request = {
      headers: { authorization: 'Bearer ', 'x-node-id': 'node-1' },
    } as unknown as IncomingMessage;

    const result = await authenticator.authenticate(request);
    expect(result.success).toBe(false);
    expect(repository.getNodeSecret).not.toHaveBeenCalled();
  });
});
