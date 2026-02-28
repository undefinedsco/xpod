import { describe, it, expect, vi } from 'vitest';
import { EdgeNodeRepository } from '../../src/identity/drizzle/EdgeNodeRepository';

function createRepo() {
  const execute = vi.fn();
  const transaction = vi.fn(async (callback: any) => {
    const txExecute = vi.fn();
    await callback({ execute: txExecute });
    return txExecute;
  });
  const repo = new EdgeNodeRepository({ execute, transaction } as any);
  return { repo, execute, transaction };
}

describe('EdgeNodeRepository', () => {
  it('getNodeSecret 返回节点凭据', async () => {
    const { repo, execute } = createRepo();
    execute.mockResolvedValueOnce({
      rows: [
        {
          id: 'node-1',
          display_name: 'Edge A',
          token_hash: 'deadbeef',
          metadata: { baseUrl: 'https://node.example/' },
        },
      ],
    });

    const secret = await repo.getNodeSecret('node-1');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(secret).toEqual({
      nodeId: 'node-1',
      displayName: 'Edge A',
      tokenHash: 'deadbeef',
      nodeType: 'edge',
      metadata: { baseUrl: 'https://node.example/' },
    });
  });

  it('getNodeSecret 未命中返回 undefined', async () => {
    const { repo, execute } = createRepo();
    execute.mockResolvedValueOnce({ rows: [] });
    const secret = await repo.getNodeSecret('node-404');
    expect(secret).toBeUndefined();
  });

  it('updateNodeHeartbeat 写入 metadata 与时间', async () => {
    const { repo, execute } = createRepo();
    execute.mockResolvedValue({ rows: [] });
    const ts = new Date('2024-01-01T00:00:00.000Z');

    await repo.updateNodeHeartbeat('node-1', { baseUrl: 'https://node.example/' }, ts);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('replaceNodePods 使用事务更新', async () => {
    const { repo, transaction } = createRepo();
    const txExecute = vi.fn();
    transaction.mockImplementationOnce(async (callback: any): Promise<any> => {
      await callback({ execute: txExecute });
    });

    await repo.replaceNodePods('node-1', [ 'https://pods.example.com/alice/' ]);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txExecute).toHaveBeenCalledTimes(2);
  });

  it('findNodeByResourcePath 返回匹配记录', async () => {
    const { repo, execute } = createRepo();
    execute.mockResolvedValueOnce({
      rows: [ {
        id: 'node-9',
        base_url: 'https://pods.example.com/alice/',
        metadata: { publicAddress: 'https://edge-1.example/' },
      } ],
    });

    const record = await repo.findNodeByResourcePath('https://pods.example.com/alice/profile/card');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(record).toEqual({
      nodeId: 'node-9',
      baseUrl: 'https://pods.example.com/alice/',
      metadata: { publicAddress: 'https://edge-1.example/' },
    });
  });

  it('matchesToken 校验哈希是否匹配', () => {
    const { repo } = createRepo();
    const token = 'secret';
    const hash = '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b';
    expect(repo.matchesToken(hash, token)).toBe(true);
    expect(repo.matchesToken(hash, 'wrong')).toBe(false);
    expect(repo.matchesToken('', token)).toBe(false);
  });

  // ============ SP Node Methods ============

  it('registerSpNode 插入 SP 节点并返回 tokens', async () => {
    const { repo, execute } = createRepo();
    execute.mockResolvedValueOnce({ rows: [] });

    const result = await repo.registerSpNode({
      publicUrl: 'https://sp.example.com',
      displayName: 'My NAS',
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.nodeId).toBeDefined();
    expect(result.nodeToken).toBeDefined();
    expect(result.serviceToken).toBeDefined();
    expect(result.createdAt).toBeDefined();
  });

  it('registerSpNode 使用传入的 nodeId 和 serviceToken', async () => {
    const { repo, execute } = createRepo();
    execute.mockResolvedValueOnce({ rows: [] });

    const result = await repo.registerSpNode({
      publicUrl: 'https://sp.example.com',
      nodeId: 'my-device-id',
      serviceToken: 'my-token',
    });

    expect(result.nodeId).toBe('my-device-id');
    expect(result.serviceToken).toBe('my-token');
    expect(result.nodeToken).toBeDefined();
  });

  it('getSpNode 返回 SP 节点信息', async () => {
    const { repo, execute } = createRepo();
    execute.mockResolvedValueOnce({
      rows: [{
        id: 'sp-1',
        display_name: 'My NAS',
        public_url: 'https://sp.example.com',
        service_token_hash: 'st-xxx',
        last_seen: null,
      }],
    });

    const node = await repo.getSpNode('sp-1');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(node).toEqual({
      nodeId: 'sp-1',
      displayName: 'My NAS',
      publicUrl: 'https://sp.example.com',
      serviceTokenHash: 'st-xxx',
      lastSeen: undefined,
    });
  });

  it('getSpNode 未命中返回 undefined', async () => {
    const { repo, execute } = createRepo();
    execute.mockResolvedValueOnce({ rows: [] });

    const node = await repo.getSpNode('sp-404');
    expect(node).toBeUndefined();
  });

  it('getNodeSecret 返回 sp 类型节点', async () => {
    const { repo, execute } = createRepo();
    execute.mockResolvedValueOnce({
      rows: [{
        id: 'sp-1',
        display_name: 'SP Node',
        token_hash: 'abc123',
        node_type: 'sp',
        metadata: null,
      }],
    });

    const secret = await repo.getNodeSecret('sp-1');
    expect(secret).toEqual({
      nodeId: 'sp-1',
      displayName: 'SP Node',
      tokenHash: 'abc123',
      nodeType: 'sp',
      metadata: null,
    });
  });
});
