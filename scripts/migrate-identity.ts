import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { getIdentityDatabase } from '../src/identity/drizzle/db';
import { accounts, passwordLogins, pods, podOwners, webIdLinks } from '../src/identity/drizzle/schema';

interface AccountPayload {
  id: string;
  rememberLogin?: boolean;
  quotaLimit?: number;
  [key: string]: any;
}

interface MigrationCounters {
  accounts: number;
  passwordLogins: number;
  pods: number;
  podOwners: number;
  webIds: number;
}

const DATA_DIR = path.join('.internal', 'accounts', 'data');

function pickBlock(record: Record<string, any>, candidates: string[]): any {
  for (const candidate of candidates) {
    if (candidate in record) {
      return record[candidate];
    }
  }
  return undefined;
}

async function migrate(): Promise<void> {
  const connectionString = process.env.IDENTITY_DB_URL;
  if (!connectionString) {
    throw new Error('Set IDENTITY_DB_URL to the PostgreSQL connection string before running the migration.');
  }

  const db = getIdentityDatabase(connectionString);
  const counters: MigrationCounters = { accounts: 0, passwordLogins: 0, pods: 0, podOwners: 0, webIds: 0 };

  let files: string[] = [];
  try {
    files = await fs.readdir(DATA_DIR);
  } catch (error) {
    throw new Error(`Failed to read account data directory ${DATA_DIR}: ${(error as Error).message}`);
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const content = await fs.readFile(path.join(DATA_DIR, file), 'utf8');
    let payload: AccountPayload;
    try {
      const parsed = JSON.parse(content);
      payload = parsed.payload as AccountPayload;
    } catch (error) {
      console.warn(`Skipping ${file}: unable to parse JSON - ${(error as Error).message}`);
      continue;
    }

    if (!payload?.id) {
      console.warn(`Skipping ${file}: missing account id`);
      continue;
    }

    const rememberLogin = payload.rememberLogin ?? payload.remember_login ?? false;
    const quotaLimit = payload.quotaLimit ?? payload.quota_limit ?? null;

    await db.insert(accounts)
      .values({ id: payload.id, rememberLogin, quotaLimit })
      .onConflictDoUpdate({
        target: accounts.id,
        set: { rememberLogin, quotaLimit, updatedAt: sql`now()` },
      });
    counters.accounts += 1;

    const passwordBlock = pickBlock(payload, ['**password**', 'password']);
    if (passwordBlock && typeof passwordBlock === 'object') {
      for (const [ loginId, login ] of Object.entries<any>(passwordBlock)) {
        await db.insert(passwordLogins)
          .values({
            id: loginId,
            accountId: payload.id,
            email: login.email,
            passwordHash: login.password ?? login.passwordHash,
            verified: Boolean(login.verified),
          })
          .onConflictDoUpdate({
            target: passwordLogins.id,
            set: {
              email: login.email,
              passwordHash: login.password ?? login.passwordHash,
              verified: Boolean(login.verified),
            },
          });
        counters.passwordLogins += 1;
      }
    }

    const webIdBlock = pickBlock(payload, ['**webIdLink**', 'webIdLink']);
    if (webIdBlock && typeof webIdBlock === 'object') {
      for (const [ linkId, link ] of Object.entries<any>(webIdBlock)) {
        await db.insert(webIdLinks)
          .values({ id: linkId, accountId: payload.id, webId: link.webId ?? link.webid ?? '' })
          .onConflictDoUpdate({
            target: webIdLinks.id,
            set: { webId: link.webId ?? link.webid ?? '' },
          });
        counters.webIds += 1;
      }
    }

    const podBlock = pickBlock(payload, ['**pod**', 'pod']);
    if (podBlock && typeof podBlock === 'object') {
      for (const [ podId, pod ] of Object.entries<any>(podBlock)) {
        const baseUrl = pod.baseUrl ?? pod.base_url;
        const podQuota = pod.quotaLimit ?? pod.quota_limit ?? null;
        await db.insert(pods)
          .values({ id: podId, accountId: payload.id, baseUrl, quotaLimit: podQuota })
          .onConflictDoUpdate({
            target: pods.id,
            set: { accountId: payload.id, baseUrl, quotaLimit: podQuota },
          });
        counters.pods += 1;

        const ownerBlock = pickBlock(pod, ['**owner**', 'owner']);
        if (ownerBlock && typeof ownerBlock === 'object') {
          for (const [ ownerId, owner ] of Object.entries<any>(ownerBlock)) {
            const webId = owner.webId ?? owner.webid;
            const visible = Boolean(owner.visible);
            await db.insert(podOwners)
              .values({ id: ownerId, podId, webId, visible })
              .onConflictDoUpdate({
                target: podOwners.id,
                set: { podId, webId, visible },
              });
            counters.podOwners += 1;
          }
        }
      }
    }
  }

  console.info('Migration complete:', counters);
}

void migrate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
