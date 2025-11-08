import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { AccountStore, LoginStorage } from '@solid/community-server';
import { DrizzleAccountLoginStorage } from '../../src/identity/drizzle/DrizzleAccountLoginStorage';
import { getIdentityDatabase } from '../../src/identity/drizzle/db';
import { Pool } from 'pg';
import fs from 'node:fs';

// Use test database URL - PostgreSQL only (DrizzleIndexedStorage requires pg)  
const testDbUrl = process.env.CSS_IDENTITY_DB_URL || 'postgresql://postgres:test@localhost:5432/xpod_test?directConnection=true';

// Only run if integration tests are enabled AND we have a PostgreSQL URL explicitly set
const shouldRunTest = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && 
                      process.env.CSS_IDENTITY_DB_URL && 
                      testDbUrl.startsWith('postgresql://');
const suite = shouldRunTest ? describe : describe.skip;

suite('DrizzleAccountLoginStorage integration', () => {
  let storage: DrizzleAccountLoginStorage;
  let pool: Pool;

  beforeAll(async () => {
    // Verify PostgreSQL connection
    try {
      pool = new Pool({ connectionString: testDbUrl });
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(`Cannot connect to PostgreSQL test database at ${testDbUrl}. Error: ${error}`);
    }

    storage = new DrizzleAccountLoginStorage({
      identityDbUrl: testDbUrl,
      tablePrefix: 'test_identity_',
      expirationSeconds: 3600,
    });
  });

  afterAll(async () => {
    // Clean up test tables
    if (pool) {
      try {
        await pool.query(`
          DROP TABLE IF EXISTS test_identity_account CASCADE;
          DROP TABLE IF EXISTS test_identity_login CASCADE;
        `);
      } catch (error) {
        console.warn('Failed to clean up test tables:', error);
      }
      await pool.end();
    }
  });

  describe('account management', () => {
    const testEmail = 'test@example.com';
    const testPassword = 'TestPassword123!';
    let accountId: string;

    it('creates a new account', async () => {
      accountId = await storage.create(testEmail, testPassword);
      expect(typeof accountId).toBe('string');
      expect(accountId.length).toBeGreaterThan(0);
    });

    it('authenticates with correct credentials', async () => {
      const result = await storage.authenticate(testEmail, testPassword);
      expect(result).toBe(accountId);
    });

    it('rejects incorrect password', async () => {
      await expect(storage.authenticate(testEmail, 'wrong-password')).rejects.toThrow();
    });

    it('rejects non-existent email', async () => {
      await expect(storage.authenticate('nonexistent@example.com', testPassword)).rejects.toThrow();
    });

    it('changes password successfully', async () => {
      const newPassword = 'NewPassword456!';
      await storage.changePassword(testEmail, newPassword);
      
      // Old password should no longer work
      await expect(storage.authenticate(testEmail, testPassword)).rejects.toThrow();
      
      // New password should work
      const result = await storage.authenticate(testEmail, newPassword);
      expect(result).toBe(accountId);
    });

    it('deletes account', async () => {
      await storage.deleteAccount(testEmail);
      
      // Should no longer be able to authenticate
      await expect(storage.authenticate(testEmail, 'NewPassword456!')).rejects.toThrow();
    });
  });

  describe('login session management', () => {
    const sessionEmail = 'session@example.com';
    const sessionPassword = 'SessionPass123!';
    let sessionAccountId: string;
    let loginId: string;

    beforeAll(async () => {
      sessionAccountId = await storage.create(sessionEmail, sessionPassword);
    });

    afterAll(async () => {
      try {
        await storage.deleteAccount(sessionEmail);
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    it('creates a login session', async () => {
      loginId = await storage.generate(sessionAccountId, {
        webId: `https://example.com/profile/${sessionAccountId}#me`,
        oidc: { issuer: 'https://example.com/' },
      }, { remember: true });
      
      expect(typeof loginId).toBe('string');
      expect(loginId.length).toBeGreaterThan(0);
    });

    it('retrieves login session data', async () => {
      const loginData = await storage.get(loginId);
      
      expect(loginData.accountId).toBe(sessionAccountId);
      expect(loginData.webId).toBe(`https://example.com/profile/${sessionAccountId}#me`);
      expect(loginData.oidc?.issuer).toBe('https://example.com/');
      expect(loginData.remember).toBe(true);
    });

    it('confirms login session exists', async () => {
      const confirmed = await storage.confirm(loginId);
      expect(confirmed).toBe(sessionAccountId);
    });

    it('deletes login session', async () => {
      await storage.delete(loginId);
      
      // Should no longer exist
      await expect(storage.get(loginId)).rejects.toThrow();
      await expect(storage.confirm(loginId)).rejects.toThrow();
    });
  });

  describe('forgot password flow', () => {
    const forgotEmail = 'forgot@example.com';
    const forgotPassword = 'ForgotPass123!';
    let forgotAccountId: string;

    beforeAll(async () => {
      forgotAccountId = await storage.create(forgotEmail, forgotPassword);
    });

    afterAll(async () => {
      try {
        await storage.deleteAccount(forgotEmail);
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    it('generates forgot password record', async () => {
      const forgotRecord = await storage.generateForgotPasswordRecord(forgotEmail);
      expect(typeof forgotRecord).toBe('string');
      expect(forgotRecord.length).toBeGreaterThan(0);
    });

    it('retrieves forgot password record', async () => {
      const recordId = await storage.generateForgotPasswordRecord(forgotEmail);
      const data = await storage.getForgotPasswordRecord(recordId);
      
      expect(data.email).toBe(forgotEmail);
      expect(typeof data.created).toBe('number');
      expect(data.created).toBeLessThanOrEqual(Date.now());
    });

    it('resets password using forgot password record', async () => {
      const recordId = await storage.generateForgotPasswordRecord(forgotEmail);
      const newPassword = 'ResetPassword789!';
      
      await storage.deleteForgotPasswordRecord(recordId);
      await storage.changePassword(forgotEmail, newPassword);
      
      // Verify new password works
      const result = await storage.authenticate(forgotEmail, newPassword);
      expect(result).toBe(forgotAccountId);
    });
  });

  describe('concurrent operations', () => {
    it('handles concurrent account creation', async () => {
      const promises = Array.from({ length: 5 }, (_, i) => 
        storage.create(`concurrent${i}@example.com`, 'ConcurrentPass123!')
      );
      
      const accountIds = await Promise.all(promises);
      
      // All should succeed and be unique
      expect(new Set(accountIds).size).toBe(5);
      
      // Cleanup
      await Promise.all(accountIds.map((_, i) => 
        storage.deleteAccount(`concurrent${i}@example.com`).catch(() => {})
      ));
    });

    it('handles concurrent login sessions', async () => {
      const email = 'multilogin@example.com';
      const accountId = await storage.create(email, 'MultiLoginPass123!');
      
      // Create multiple login sessions for same account
      const promises = Array.from({ length: 3 }, (_, i) =>
        storage.generate(accountId, {
          webId: `https://example.com/profile/${accountId}#me`,
          oidc: { issuer: 'https://example.com/' },
        }, { remember: i % 2 === 0 })
      );
      
      const loginIds = await Promise.all(promises);
      
      // All should be unique
      expect(new Set(loginIds).size).toBe(3);
      
      // All should be valid
      const confirmations = await Promise.all(
        loginIds.map(id => storage.confirm(id))
      );
      expect(confirmations.every(id => id === accountId)).toBe(true);
      
      // Cleanup
      await Promise.all([
        ...loginIds.map(id => storage.delete(id).catch(() => {})),
        storage.deleteAccount(email).catch(() => {}),
      ]);
    });
  });
});