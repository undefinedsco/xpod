/**
 * The Pod carrier for the outbound queue.
 *
 * The register's requirement is blunt about why this exists: "只落水位/进度救不回队列——队列里那批
 * **尚未发出**的事件本身就是记录的内容". A batch is what the deployment still owes a peer, so it
 * lives in that peer's sender's Pod until it is delivered or abandoned, and a restart finds it
 * again. `outboundBatches.ts` maps a batch to a row; this maps the queue's four operations onto the
 * control-record carrier.
 *
 * **Enumeration is container listing**, the standard Solid way, and it is what the layout was
 * chosen for: each day directory lists its members in one request, and the record's name prefix
 * (`outbound-…`) tells the enumerator which members to read without reading the rest. So
 * `pending(scope)` costs one listing per day in the window plus one read per batch — proportional
 * to what is owed, not to the Pod's size.
 *
 * **`scopes()` needs the deployment's help.** A Pod-backed store has no global view: it can only
 * answer for Pods it is told about, and the deployment already knows which Pods it serves
 * (`participantRoutes` derives them). Without a provider it answers with the scopes it has been
 * asked about, which is honest — "the ones I have work for" — rather than pretending to know more.
 */
import { MatrixError } from '../MatrixError';
import {
  deleteControlRecord,
  listControlRecords,
  readControlRecord,
  writeControlRecord,
  type MatrixControlRecordTarget,
} from '../controlRecords';
import { decodeOutboundBatch, encodeOutboundBatch, outboundBatchKey } from './outboundBatches';
import type { MatrixOutboundBatch, MatrixOutboundStore } from './outboundQueue';

/**
 * How many day buckets `pending` looks through.
 *
 * A batch is a promise to a peer, so the window is generous: a peer that is down for a week should
 * still get what it is owed when it returns. The cost of the window is one container listing per
 * day, which is why it can afford to be days rather than hours.
 */
export const OUTBOUND_BATCH_LOOKBACK_DAYS = 7;

export interface PodMatrixOutboundStoreOptions {
  /**
   * The Pod handle a scope's writes use, resolved from the same authority a Matrix write uses.
   * `undefined` means this deployment does not serve that scope, and the caller is told so.
   */
  handleFor: (scope: string) => Promise<MatrixControlRecordTarget | undefined>;
  /** The Pods this deployment serves. Absent means "the ones we were asked about". */
  scopes?: () => Promise<readonly string[]>;
  now?: () => number;
  lookbackDays?: number;
}

export class PodMatrixOutboundStore implements MatrixOutboundStore {
  private readonly options: PodMatrixOutboundStoreOptions;
  /** Scopes this store has been asked about, for a deployment that cannot enumerate them. */
  private readonly seen = new Set<string>();

  public constructor(options: PodMatrixOutboundStoreOptions) {
    this.options = options;
  }

  public async scopes(): Promise<readonly string[]> {
    if (this.options.scopes) return await this.options.scopes();
    return [ ...this.seen ].sort();
  }

  /** Batches still to send, oldest first. */
  public async pending(scope: string, filter?: { origin?: string; destination?: string }): Promise<MatrixOutboundBatch[]> {
    this.seen.add(scope);
    const target = await this.requireHandle(scope);
    const records = await listControlRecords(target, 'outbound', {
      at: this.now(),
      days: this.lookbackDays(),
    });
    const batches: MatrixOutboundBatch[] = [];
    for (const record of records) {
      const batch = decodeOutboundBatch(record);
      if (!batch) continue;
      if (filter?.origin !== undefined && batch.origin !== filter.origin) continue;
      if (filter?.destination !== undefined && batch.destination !== filter.destination) continue;
      batches.push(batch);
    }
    return batches.sort((left, right) => left.createdAt - right.createdAt);
  }

  /** Insert or replace one batch, keyed by its queue and transaction. */
  public async put(scope: string, batch: MatrixOutboundBatch): Promise<void> {
    this.seen.add(scope);
    const target = await this.requireHandle(scope);
    await writeControlRecord(target, {
      kind: 'outbound',
      key: outboundBatchKey(batch),
      // The batch's own moment decides its day: a batch retried tomorrow is still recorded under
      // the day it was created, so the day it lives in never moves under it.
      at: batch.createdAt,
      ...encodeOutboundBatch(batch),
    });
  }

  public async remove(scope: string, batch: { origin: string; destination: string; txnId: string }): Promise<void> {
    this.seen.add(scope);
    const target = await this.requireHandle(scope);
    const record = await readControlRecord(target, 'outbound', outboundBatchKey(batch), {
      at: this.now(),
      days: this.lookbackDays(),
    });
    // Already gone is the state we wanted; a delivery that was retried after a restart should not
    // fail because the record it is clearing has already been cleared.
    if (record) await deleteControlRecord(target, record);
  }

  private async requireHandle(scope: string): Promise<MatrixControlRecordTarget> {
    const handle = await this.options.handleFor(scope);
    if (!handle) {
      throw new MatrixError(403, 'M_FORBIDDEN', `This deployment holds no grant for ${scope}`);
    }
    if (handle.scope !== scope) {
      throw new MatrixError(500, 'M_UNKNOWN', `Outbound scope ${scope} does not match the resolved Pod ${handle.scope}`);
    }
    return handle;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private lookbackDays(): number {
    return this.options.lookbackDays ?? OUTBOUND_BATCH_LOOKBACK_DAYS;
  }
}
