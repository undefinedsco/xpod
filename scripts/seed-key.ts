import { getIdentityDatabase } from '../src/identity/drizzle/db';
import { apiClientCredentials } from '../src/identity/drizzle/schema.sqlite';
import * as dotenv from 'dotenv';
import path from 'path';
import { randomBytes, createCipheriv, scryptSync } from 'node:crypto';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

async function main() {
  const dbUrl = process.env.CSS_IDENTITY_DB_URL || 'sqlite:identity.sqlite';
  console.log(`Using DB: ${dbUrl}`);
  
  const db = getIdentityDatabase(dbUrl);
  
  const keyStr = process.env.XPOD_ENCRYPTION_KEY || 'default-dev-key-change-me';
  const encryptionKey = scryptSync(keyStr, 'xpod-api-salt', 32);

  const clientId = process.env.SOLID_CLIENT_ID!;
  const clientSecret = process.env.SOLID_CLIENT_SECRET!;
  const webId = process.env.SOLID_WEBID!;
  
  const encryptedSecret = encrypt(clientSecret, encryptionKey);

  // Use SQLite schema
  await db.insert(apiClientCredentials).values({
    clientId,
    clientSecretEncrypted: encryptedSecret,
    webId,
    accountId: webId,
    displayName: 'Google Test Account',
    createdAt: new Date(),
  }).onConflictDoUpdate({
    target: apiClientCredentials.clientId,
    set: {
      clientSecretEncrypted: encryptedSecret,
      displayName: 'Google Test Account',
    },
  });

  console.log('Key seeded successfully (SQLite mode) with real credentials.');
  console.log(`ClientID: ${clientId}`);
}

main().catch(console.error);