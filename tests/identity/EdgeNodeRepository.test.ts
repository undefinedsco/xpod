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
    transaction.mockImplementationOnce(async (callback: any) => {
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
});
