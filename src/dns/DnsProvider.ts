export type DnsRecordTypeValue = 'A' | 'AAAA' | 'CNAME' | 'TXT';
export type DnsRecordType = DnsRecordTypeValue;

export interface UpsertDnsRecordInput {
  /** 根域名，例如 `example.com`。 */
  domain: string;
  /** 子域名（相对形式），根域使用 `@`。 */
  subdomain: string;
  type: DnsRecordTypeValue;
  value: string;
  /** TTL 秒数，供应商若不支持将退回默认值。 */
  ttl?: number;
  /** DNS 线路 ID，未指定时使用默认线路。 */
  lineId?: string;
}

export interface DeleteDnsRecordInput {
  domain: string;
  subdomain: string;
  type: DnsRecordTypeValue;
  /**
   * 若提供 value，仅当记录值匹配时才删除；
   * 否则会删除第一条匹配类型的记录。
   */
  value?: string;
}

export interface DnsProvider {
  upsertRecord(options: UpsertDnsRecordInput): Promise<void>;
  deleteRecord(options: DeleteDnsRecordInput): Promise<void>;
}

export interface DnsRecordSummary {
  id: string;
  domain: string;
  subdomain: string;
  type: DnsRecordTypeValue;
  value: string;
  ttl: number;
  line: string;
  lineId: string;
}

export interface ListDnsRecordsInput {
  domain: string;
  subdomain?: string;
  type?: DnsRecordTypeValue;
}

export interface ListableDnsProvider extends DnsProvider {
  listRecords(options: ListDnsRecordsInput): Promise<DnsRecordSummary[]>;
}
