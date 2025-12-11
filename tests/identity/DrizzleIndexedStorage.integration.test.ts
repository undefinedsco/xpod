import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { DrizzleIndexedStorage } from '../../src/identity/drizzle/DrizzleIndexedStorage';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Use local SQLite for self-contained testing
const suite = describe;

suite('DrizzleIndexedStorage integration (SQLite)', () => {
  let storage: DrizzleIndexedStorage<any>;
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    // Create a temp directory for the test database
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drizzle-test-'));
    dbPath = path.join(tmpDir, 'identity.sqlite');
    const testDbUrl = `sqlite:${dbPath}`;

    // Initialize storage (this will trigger ensureSqliteTables in db.ts)
    storage = new DrizzleIndexedStorage(
      testDbUrl,
      'test_identity_',
    );
  });

  afterAll(async () => {
    // Cleanup temp directory
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('key-value storage operations', () => {
    const testType = 'account';
    const testKey = 'test-key-123';
    const testData = { 
      email: 'test@example.com', 
      passwordHash: 'hashed-secret',
      verified: true 
    };

    it('creates a new record', async () => {
      const record = await storage.create(testType, testData);
      expect(record.id).toBeDefined();
      expect(record.email).toBe(testData.email);
    });

    it('retrieves a record by ID', async () => {
      const created = await storage.create(testType, testData);
      const retrieved = await storage.get(testType, created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.email).toBe(testData.email);
    });

    it('checks if record exists', async () => {
      const created = await storage.create(testType, testData);
      const exists = await storage.has(testType, created.id);
      expect(exists).toBe(true);
      
      const nonExistent = await storage.has(testType, 'non-existent-id');
      expect(nonExistent).toBe(false);
    });

    it('updates a record', async () => {
      const created = await storage.create(testType, testData);
      const newData = { ...created, verified: false, newField: 'added' };
      
      await storage.set(testType, newData);
      const updated = await storage.get(testType, created.id);
      
      expect(updated?.verified).toBe(false);
      expect(updated?.newField).toBe('added');
    });

    it('deletes a record', async () => {
      const created = await storage.create(testType, testData);
      await storage.delete(testType, created.id);
      
      const retrieved = await storage.get(testType, created.id);
      expect(retrieved).toBeUndefined();
    });
    
    it('handles different types (buckets) in the same table', async () => {
      const sessionType = 'session';
      const sessionData = { userId: 'user-1', active: true };
      
      const account = await storage.create(testType, testData);
      const session = await storage.create(sessionType, sessionData);
      
      const retrievedAccount = await storage.get(testType, account.id);
      const retrievedSession = await storage.get(sessionType, session.id);
      
      expect(retrievedAccount).toBeDefined();
      expect(retrievedSession).toBeDefined();
      
      // Ensure isolation (cannot get session using account type)
      const wrongType = await storage.get(testType, session.id);
      expect(wrongType).toBeUndefined();
    });
  });
});