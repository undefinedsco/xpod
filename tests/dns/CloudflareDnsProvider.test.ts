import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareDnsProvider } from '../../src/dns/cloudflare/CloudflareDnsProvider';

describe('CloudflareDnsProvider', () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('should be disabled when apiToken is not provided', () => {
      const provider = new CloudflareDnsProvider({});
      expect((provider as any).enabled).toBe(false);
    });

    it('should be enabled when apiToken is provided', () => {
      const provider = new CloudflareDnsProvider({ apiToken: 'test-token' });
      expect((provider as any).enabled).toBe(true);
    });
  });

  describe('upsertRecord', () => {
    it('should skip when disabled', async () => {
      const provider = new CloudflareDnsProvider({});
      await provider.upsertRecord({
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
        value: '1.2.3.4',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should create a new record when it does not exist', async () => {
      const provider = new CloudflareDnsProvider({
        apiToken: 'test-token',
        zoneId: 'zone-123',
      });

      // Mock: 查找记录（不存在）
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: [],
        }),
      });

      // Mock: 创建记录
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: { id: 'record-1' },
        }),
      });

      await provider.upsertRecord({
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
        value: '1.2.3.4',
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      
      // 第二个调用应该是 POST 创建记录
      const createCall = mockFetch.mock.calls[1];
      expect(createCall[0]).toContain('dns_records');
      expect(createCall[1].method).toBe('POST');
      const body = JSON.parse(createCall[1].body);
      expect(body.type).toBe('A');
      expect(body.name).toBe('test.example.com');
      expect(body.content).toBe('1.2.3.4');
    });

    it('should update an existing record when values differ', async () => {
      const provider = new CloudflareDnsProvider({
        apiToken: 'test-token',
        zoneId: 'zone-123',
      });

      // Mock: 查找记录（存在但值不同）
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: [{
            id: 'record-1',
            name: 'test.example.com',
            type: 'A',
            content: '5.6.7.8',
            ttl: 1,
          }],
        }),
      });

      // Mock: 更新记录
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: { id: 'record-1' },
        }),
      });

      await provider.upsertRecord({
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
        value: '1.2.3.4',
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      
      // 第二个调用应该是 PATCH 更新记录
      const updateCall = mockFetch.mock.calls[1];
      expect(updateCall[1].method).toBe('PATCH');
    });

    it('should skip update when record already matches', async () => {
      const provider = new CloudflareDnsProvider({
        apiToken: 'test-token',
        zoneId: 'zone-123',
      });

      // Mock: 查找记录（存在且值相同）
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: [{
            id: 'record-1',
            name: 'test.example.com',
            type: 'A',
            content: '1.2.3.4',
            ttl: 1,
          }],
        }),
      });

      await provider.upsertRecord({
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
        value: '1.2.3.4',
      });

      // 只调用一次（查找），没有创建/更新
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteRecord', () => {
    it('should skip when disabled', async () => {
      const provider = new CloudflareDnsProvider({});
      await provider.deleteRecord({
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should delete an existing record', async () => {
      const provider = new CloudflareDnsProvider({
        apiToken: 'test-token',
        zoneId: 'zone-123',
      });

      // Mock: 查找记录（存在）
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: [{
            id: 'record-1',
            name: 'test.example.com',
            type: 'A',
            content: '1.2.3.4',
          }],
        }),
      });

      // Mock: 删除记录
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: { id: 'record-1' },
        }),
      });

      await provider.deleteRecord({
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      
      // 第二个调用应该是 DELETE
      const deleteCall = mockFetch.mock.calls[1];
      expect(deleteCall[1].method).toBe('DELETE');
    });

    it('should skip when record does not exist', async () => {
      const provider = new CloudflareDnsProvider({
        apiToken: 'test-token',
        zoneId: 'zone-123',
      });

      // Mock: 查找记录（不存在）
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: [],
        }),
      });

      await provider.deleteRecord({
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
      });

      // 只调用一次（查找），没有删除
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getZoneId', () => {
    it('should use configured zoneId when provided', async () => {
      const provider = new CloudflareDnsProvider({
        apiToken: 'test-token',
        zoneId: 'configured-zone-id',
      });

      // Mock: 查找记录
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: [],
        }),
      });

      // Mock: 创建记录
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: { id: 'record-1' },
        }),
      });

      await provider.upsertRecord({
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
        value: '1.2.3.4',
      });

      // 确保使用了配置的 zoneId
      expect(mockFetch.mock.calls[0][0]).toContain('configured-zone-id');
    });

    it('should auto-detect zoneId when not provided', async () => {
      const provider = new CloudflareDnsProvider({
        apiToken: 'test-token',
      });

      // Mock: 查找 Zone
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: [{ id: 'auto-detected-zone', name: 'example.com', status: 'active' }],
        }),
      });

      // Mock: 查找记录
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: [],
        }),
      });

      // Mock: 创建记录
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: { id: 'record-1' },
        }),
      });

      await provider.upsertRecord({
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
        value: '1.2.3.4',
      });

      // 第一次调用应该是查找 Zone
      expect(mockFetch.mock.calls[0][0]).toContain('zones?name=');
      // 后续调用应该使用自动检测的 zoneId
      expect(mockFetch.mock.calls[1][0]).toContain('auto-detected-zone');
    });
  });

  describe('listRecords', () => {
    it('should return empty array when disabled', async () => {
      const provider = new CloudflareDnsProvider({});
      const records = await provider.listRecords({ domain: 'example.com' });
      expect(records).toEqual([]);
    });

    it('should list records and convert to summary format', async () => {
      const provider = new CloudflareDnsProvider({
        apiToken: 'test-token',
        zoneId: 'zone-123',
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: true,
          errors: [],
          result: [
            {
              id: 'record-1',
              zone_id: 'zone-123',
              zone_name: 'example.com',
              name: 'test.example.com',
              type: 'A',
              content: '1.2.3.4',
              ttl: 300,
              proxied: false,
            },
            {
              id: 'record-2',
              zone_id: 'zone-123',
              zone_name: 'example.com',
              name: 'example.com',
              type: 'A',
              content: '5.6.7.8',
              ttl: 1,
              proxied: true,
            },
          ],
        }),
      });

      const records = await provider.listRecords({ domain: 'example.com' });

      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({
        id: 'record-1',
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
        value: '1.2.3.4',
        ttl: 300,
        line: 'default',
        lineId: 'default',
      });
      expect(records[1].subdomain).toBe('@');
    });
  });

  describe('error handling', () => {
    it('should throw on API error', async () => {
      const provider = new CloudflareDnsProvider({
        apiToken: 'test-token',
        zoneId: 'zone-123',
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          success: false,
          errors: [{ code: 1001, message: 'Invalid zone identifier' }],
          result: null,
        }),
      });

      await expect(provider.upsertRecord({
        domain: 'example.com',
        subdomain: 'test',
        type: 'A',
        value: '1.2.3.4',
      })).rejects.toThrow('Cloudflare API 错误');
    });
  });
});

/**
 * N14: the provider used to look up "the first record with this name" and delete it whenever its
 * type differed, so writing an A record could remove an MX or the `_acme-challenge` TXT that
 * shares the name. Only CNAME is mutually exclusive with other types (RFC 1034); everything else
 * coexists and must be left alone.
 */
describe('CloudflareDnsProvider record-type safety (N14)', () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function provider(): CloudflareDnsProvider {
    return new CloudflareDnsProvider({ apiToken: 'test-token', zoneId: 'zone-123' });
  }

  function listResult(records: Array<{ id: string; type: string; name: string; content: string; ttl?: number }>) {
    return { json: async () => ({ success: true, errors: [], result: records }) };
  }

  function writeResult(id = 'created-1'): { json: () => Promise<unknown> } {
    return { json: async () => ({ success: true, errors: [], result: { id } }) };
  }

  function requests(): string[] {
    return mockFetch.mock.calls.map((call) => String(call[0]));
  }

  it('keeps an MX record that shares the name with the A record being written', async () => {
    mockFetch.mockResolvedValueOnce(listResult([
      { id: 'mx-1', type: 'MX', name: 'test.example.com', content: 'mail.example.com' },
    ]));
    mockFetch.mockResolvedValueOnce(writeResult());

    await provider().upsertRecord({ domain: 'example.com', subdomain: 'test', type: 'A', value: '1.2.3.4' });

    expect(requests().some((url) => url.includes('/dns_records/mx-1'))).toBe(false);
    expect(mockFetch.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false);
    expect(mockFetch.mock.calls[1][1]?.method).toBe('POST');
  });

  it('keeps a TXT record that shares the name with the A record being written', async () => {
    mockFetch.mockResolvedValueOnce(listResult([
      { id: 'txt-1', type: 'TXT', name: 'test.example.com', content: 'v=spf1 -all' },
    ]));
    mockFetch.mockResolvedValueOnce(writeResult());

    await provider().upsertRecord({ domain: 'example.com', subdomain: 'test', type: 'A', value: '1.2.3.4' });

    expect(requests().some((url) => url.includes('/dns_records/txt-1'))).toBe(false);
  });

  it('keeps an A record when writing the _acme-challenge TXT for the same name', async () => {
    mockFetch.mockResolvedValueOnce(listResult([
      { id: 'a-1', type: 'A', name: '_acme-challenge.example.com', content: '1.2.3.4' },
    ]));
    mockFetch.mockResolvedValueOnce(writeResult());

    await provider().upsertRecord({
      domain: 'example.com',
      subdomain: '_acme-challenge',
      type: 'TXT',
      value: 'validation-token',
    });

    expect(requests().some((url) => url.includes('/dns_records/a-1'))).toBe(false);
  });

  it('replaces a CNAME because that type cannot coexist, and deletes it by id', async () => {
    mockFetch.mockResolvedValueOnce(listResult([
      { id: 'cname-1', type: 'CNAME', name: 'test.example.com', content: 'old.example.com' },
    ]));
    mockFetch.mockResolvedValueOnce(writeResult());
    mockFetch.mockResolvedValueOnce(writeResult('a-created'));

    await provider().upsertRecord({ domain: 'example.com', subdomain: 'test', type: 'A', value: '1.2.3.4' });

    const deleteCall = mockFetch.mock.calls.find((call) => call[1]?.method === 'DELETE');
    expect(String(deleteCall?.[0])).toContain('/dns_records/cname-1');
    expect(mockFetch.mock.calls.at(-1)?.[1]?.method).toBe('POST');
  });

  it('replaces an A record when writing a CNAME for the same name', async () => {
    mockFetch.mockResolvedValueOnce(listResult([
      { id: 'a-1', type: 'A', name: 'test.example.com', content: '1.2.3.4' },
    ]));
    mockFetch.mockResolvedValueOnce(writeResult());
    mockFetch.mockResolvedValueOnce(writeResult('cname-created'));

    await provider().upsertRecord({ domain: 'example.com', subdomain: 'test', type: 'CNAME', value: 'target.example.com' });

    const deleteCall = mockFetch.mock.calls.find((call) => call[1]?.method === 'DELETE');
    expect(String(deleteCall?.[0])).toContain('/dns_records/a-1');
  });

  it('updates its own record in place when the same type already exists', async () => {
    mockFetch.mockResolvedValueOnce(listResult([
      { id: 'a-existing', type: 'A', name: 'test.example.com', content: '1.1.1.1' },
      { id: 'mx-1', type: 'MX', name: 'test.example.com', content: 'mail.example.com' },
    ]));
    mockFetch.mockResolvedValueOnce(writeResult());

    await provider().upsertRecord({ domain: 'example.com', subdomain: 'test', type: 'A', value: '2.2.2.2' });

    const patchCall = mockFetch.mock.calls.find((call) => call[1]?.method === 'PATCH');
    expect(String(patchCall?.[0])).toContain('/dns_records/a-existing');
    expect(mockFetch.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false);
    expect(mockFetch.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('deletes only the requested type when several types share the name', async () => {
    // A real API honours the type filter; the mock has to as well, otherwise this test would be
    // asserting behaviour against a server that lies about the query.
    const records = [
      { id: 'a-1', type: 'A', name: 'test.example.com', content: '1.2.3.4' },
      { id: 'txt-1', type: 'TXT', name: 'test.example.com', content: 'v=spf1 -all' },
    ];
    mockFetch.mockImplementationOnce(async (url: string) => {
      const requestedType = new URL(String(url)).searchParams.get('type');
      return listResult(records.filter((record) => !requestedType || record.type === requestedType));
    });
    mockFetch.mockResolvedValueOnce(writeResult());

    await provider().deleteRecord({ domain: 'example.com', subdomain: 'test', type: 'TXT' });

    const deleteCall = mockFetch.mock.calls.find((call) => call[1]?.method === 'DELETE');
    expect(String(deleteCall?.[0])).toContain('/dns_records/txt-1');
    expect(requests().some((url) => url.includes('/dns_records/a-1'))).toBe(false);
    // The type filter is pushed into the lookup query, not guessed from the first result.
    expect(requests()[0]).toContain('type=TXT');
  });

  it('refuses to delete a record whose type does not match the request', async () => {
    mockFetch.mockResolvedValueOnce(listResult([
      { id: 'mx-1', type: 'MX', name: 'test.example.com', content: 'mail.example.com' },
    ]));

    await provider().deleteRecord({ domain: 'example.com', subdomain: 'test', type: 'A' });

    expect(mockFetch.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false);
  });
});
