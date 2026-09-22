import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';

const postgresUrl = process.env.XPOD_MATRIX_TEST_POSTGRES_URL;
const scopes: string[] = [];
const pools: Pool[] = [];

function database() {
  const pool = new Pool({ connectionString: postgresUrl, max: 8, application_name: `matrix-journal-test-${randomUUID()}` });
  pools.push(pool);
  return { pool, db: drizzle(pool) };
}

function newScope(): string {
  const scope = `https://matrix-journal-test.invalid/${randomUUID()}/`;
  scopes.push(scope);
  return scope;
}

afterEach(async () => {
  try {
    if (!pools.length) return;
    const pool = pools[pools.length - 1];
    for (const scope of scopes.splice(0)) {
      for (const table of ['xpod_matrix_transactions', 'xpod_matrix_events']) {
        const exists = await pool.query('SELECT to_regclass($1) AS name', [table]);
        if (exists.rows[0].name) {
          await pool.query(`DELETE FROM ${table} WHERE scope = $1`, [scope]);
        }
      }
    }
  } finally {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  }
});

describe.skipIf(!postgresUrl)('Matrix journal real PostgreSQL', () => {
  it('converges concurrent lazy initialization, reservations and duplicate registrations', async () => {
    const scope = newScope();
    const { db } = database();
    const journals = Array.from({ length: 12 }, () => new SqlMatrixEventJournal(db));
    const attempts = await Promise.allSettled(journals.map((journal, index) => journal.reserveTransaction(scope, 'same-txn', {
      eventId: `$candidate-${index}`, contentHash: `hash-${index}`, createdAt: 1_700_000_000_000 + index,
    })));
    const failed = attempts.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const reservations = attempts.map((result) => {
      if (result.status !== 'fulfilled') throw new Error('Unsuccessful reservation');
      return result.value;
    });
    expect(new Set(reservations.map((reservation) => JSON.stringify(reservation))).size).toBe(1);
    const sequences = await Promise.all(journals.map((journal) => journal.registerEvent(scope, '!room', reservations[0].eventId)));
    expect(new Set(sequences).size).toBe(1);
    expect(await journals[0].findReservation(scope, reservations[0].eventId)).toEqual(reservations[0]);
  });

  it('does not advance the cursor past an earlier uncommitted event', async () => {
    const scope = newScope();
    const { pool, db } = database();
    const journal = new SqlMatrixEventJournal(db);
    const initial = await journal.registerEvent(scope, '!room', '$initial');
    const writer = await pool.connect();
    let later: Promise<number> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query('LOCK TABLE xpod_matrix_events IN SHARE ROW EXCLUSIVE MODE');
      const inserted = await writer.query(
        'INSERT INTO xpod_matrix_events (scope, room_id, event_id) VALUES ($1, $2, $3) RETURNING sequence',
        [scope, '!room', '$uncommitted'],
      );
      const earlier = Number(inserted.rows[0].sequence);
      later = journal.registerEvent(scope, '!room', '$later');
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const waiting = await pool.query(`SELECT EXISTS (
          SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.relation = 'xpod_matrix_events'::regclass AND NOT l.granted AND a.application_name = $1
        ) AS blocked`, [pool.options.application_name]);
        blocked = waiting.rows[0].blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(await journal.getHighWatermark(scope)).toBe(initial);
      await writer.query('COMMIT');
      const subsequent = await later;
      expect(subsequent).toBeGreaterThan(earlier);
      expect(await journal.getHighWatermark(scope)).toBe(subsequent);
      expect(await journal.registerEvent(scope, '!room', '$uncommitted')).toBe(earlier);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await later?.catch(() => undefined);
    }
  });

  it('preserves transaction identity and event sequence after pool reopen', async () => {
    const scope = newScope();
    const first = database();
    const journal = new SqlMatrixEventJournal(first.db);
    const candidate = { eventId: '$persisted', contentHash: 'hash', createdAt: Date.now() };
    await journal.reserveTransaction(scope, 'txn', candidate);
    const sequence = await journal.registerEvent(scope, '!room', candidate.eventId);
    pools.splice(pools.indexOf(first.pool), 1);
    await first.pool.end();
    const reopened = new SqlMatrixEventJournal(database().db);
    expect(await reopened.reserveTransaction(scope, 'txn', { ...candidate, eventId: '$different' })).toEqual(candidate);
    expect(await reopened.registerEvent(scope, '!room', candidate.eventId)).toBe(sequence);
    expect(await reopened.getHighWatermark(scope)).toBe(sequence);
    expect(await reopened.registerEvent(scope, '!room', '$new')).toBeGreaterThan(sequence);
  });
});
