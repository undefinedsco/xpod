/**
 * The Pod carrier for event reservations: the identity-pinning half of the journal.
 *
 * A reservation answers "which event identity does this client transaction own", and it has to be
 * durable for the same reason a receipt does — a replay after a restart must land on the event the
 * first attempt reserved, or one client send becomes two events. This keeps that record in the
 * participant's Pod through the control-record carrier, addressed by the transaction key itself
 * (records are already sharded per Pod, so the scope need not be repeated in the key).
 *
 * The *sequence* half stays with the deployment's database, delegated untouched: it is a
 * rebuildable local accelerator for ordering (events are read by `(createdAt, id)` and numbered in
 * that order, which a test pins), not a protocol fact that belongs in a Pod. So this class is the
 * boundary the register drew — transaction records in the Pod, ordering left local.
 *
 * Reading a reservation back needs the event, not just its id: the key names the device that sent
 * it, which is why the row stores `txnDevice` and why `reservationKeyForEvent` exists. Without a
 * key the answer is `undefined` — "no receipt" must stay distinguishable from "somebody else's".
 */
import { TaskStatus } from '@undefineds.co/models';
import type { TaskStatusType } from '@undefineds.co/models';
import { MatrixError } from './MatrixError';
import {
  readControlRecord,
  updateControlRecord,
  writeControlRecord,
  type MatrixControlRecord,
  type MatrixControlRecordTarget,
} from './controlRecords';
import type {
  MatrixEventJournal,
  MatrixReservationLookup,
  MatrixTransactionReservation,
} from './MatrixEventJournal';
import { reservationKeyForEvent } from './MatrixEventJournal';

export interface PodMatrixEventJournalOptions {
  /** Where sequence registration stays: the deployment's own, rebuildable ordering. */
  sequences: MatrixEventJournal;
}

export class PodMatrixEventJournal implements MatrixEventJournal {
  public constructor(private readonly options: PodMatrixEventJournalOptions) {}

  /**
   * Claim the identity a transaction will use, or adopt the one already claimed.
   *
   * `createdAt` is the reservation's own timestamp, and it decides which day the record lives in:
   * a retry carrying a *later* proposal must still find the first record, which the lookup window
   * covers across midnight as well.
   */
  public async reserveTransaction(
    scope: string,
    key: string,
    candidate: MatrixTransactionReservation,
    authority?: MatrixControlRecordTarget,
  ): Promise<MatrixTransactionReservation> {
    const target = this.requireHandle(scope, authority);
    const { record } = await writeControlRecord(target, {
      kind: 'txn',
      key,
      at: candidate.createdAt,
      instruction: `Reserve the event identity for transaction ${key}`,
      status: TaskStatus.ACTIVE as TaskStatusType,
      metadata: { eventId: candidate.eventId, createdAt: candidate.createdAt, contentHash: candidate.contentHash },
    });
    return decodeReservation(record);
  }

  /** Replace a reservation whose output was never written; see the interface's note. */
  public async replaceReservation(
    scope: string,
    key: string,
    candidate: MatrixTransactionReservation,
    authority?: MatrixControlRecordTarget,
  ): Promise<void> {
    const target = this.requireHandle(scope, authority);
    const record = await readControlRecord(target, 'txn', key, { at: candidate.createdAt });
    if (!record) throw new MatrixError(500, 'M_UNKNOWN', `No reservation ${key} to replace`);
    await updateControlRecord(target, record, {
      status: record.status,
      metadata: { ...record.metadata, eventId: candidate.eventId, createdAt: candidate.createdAt, contentHash: candidate.contentHash },
    });
  }

  /** Which reservation produced this event: one point lookup, from the event alone. */
  public async findReservation(
    scope: string,
    event: MatrixReservationLookup,
    authority?: MatrixControlRecordTarget,
  ): Promise<MatrixTransactionReservation | undefined> {
    const key = reservationKeyForEvent(event);
    if (!key) return undefined;
    const target = this.requireHandle(scope, authority);
    const record = await readControlRecord(target, 'txn', key);
    return record ? decodeReservation(record) : undefined;
  }

  /** The same, for a page of scanned events: one lookup each, keyed by the events themselves. */
  public async findReservations(
    scope: string,
    events: readonly MatrixReservationLookup[],
    authority?: MatrixControlRecordTarget,
  ): Promise<Map<string, MatrixTransactionReservation>> {
    const found = new Map<string, MatrixTransactionReservation>();
    for (const event of events) {
      const reservation = await this.findReservation(scope, event, authority);
      if (reservation) found.set(event.eventId, reservation);
    }
    return found;
  }

  /** Ordering is the deployment's own, rebuildable from the Pod; it does not move in here. */
  public async registerEvent(scope: string, roomId: string, eventId: string): Promise<number> {
    return await this.options.sequences.registerEvent(scope, roomId, eventId);
  }

  public async registerEvents(scope: string, roomId: string, eventIds: readonly string[]): Promise<number[]> {
    return await this.options.sequences.registerEvents(scope, roomId, eventIds);
  }

  public async getHighWatermark(scope: string): Promise<number> {
    return await this.options.sequences.getHighWatermark(scope);
  }

  /**
   * The handle the caller supplied, checked against the scope it claims.
   *
   * Required, not guessed: a reservation written under the wrong authority would either fail (the
   * measured case) or, worse, succeed with authority the caller does not have.
   */
  private requireHandle(scope: string, handle: MatrixControlRecordTarget | undefined): MatrixControlRecordTarget {
    if (!handle) {
      throw new MatrixError(403, 'M_FORBIDDEN',
        `A reservation for ${scope} needs the caller's authority; this deployment will not guess one`);
    }
    if (handle.scope !== scope) {
      throw new MatrixError(500, 'M_UNKNOWN', `Reservation scope ${scope} does not match the resolved Pod ${handle.scope}`);
    }
    return handle;
  }
}

/** A record holds the reservation in its metadata; a record that does not is a broken one. */
function decodeReservation(record: MatrixControlRecord): MatrixTransactionReservation {
  const { eventId, createdAt, contentHash } = record.metadata;
  if (typeof eventId !== 'string' || typeof createdAt !== 'number' || typeof contentHash !== 'string') {
    throw new MatrixError(500, 'M_UNKNOWN', `Reservation ${record.key} has no usable receipt`);
  }
  return { eventId, createdAt, contentHash };
}
