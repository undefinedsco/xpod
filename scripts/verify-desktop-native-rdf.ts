/**
 * Real-Pod drizzle CRUD verifier for the isolated local QLever runtime.
 *
 * Starts an isolated Xpod local runtime with a same-OS native QLever, creates an
 * account + client-credentials session, then exercises the exact structured path
 * that failed in acceptance (`.data` drizzle insert/find/update/delete) and writes
 * logs/evidence under `.test-data/go-b-native/`.
 */
import '../src/runtime/configure-drizzle-solid';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { approvalResource, decideApprovalRequest } from '@undefineds.co/models';
import { startXpodRuntime } from '../src/runtime/XpodRuntime';
import { loginWithClientCredentials, setupAccount } from '../tests/integration/helpers/solidAccount';

const root = `${process.cwd()}/.test-data/go-b-native`;
mkdirSync(root, { recursive: true });
// Old ABI migrations may have shaped a prior runtime root; always start clean.
const runtimeRoot = `${root}/runtime-verified`;
rmSync(runtimeRoot, { recursive: true, force: true });

const base = process.env.XPOD_NATIVE_VERIFY_BASE ?? 'http://localhost:58391/';
const gatewayPort = Number(process.env.XPOD_NATIVE_VERIFY_GATEWAY_PORT ?? 58391);
const cssPort = gatewayPort + 1;
const apiPort = gatewayPort + 2;

const runtime = await startXpodRuntime({
  mode: 'local',
  transport: 'port',
  gatewayPort,
  cssPort,
  apiPort,
  baseUrl: base,
  runtimeRoot,
  env: {
    SOLID_OIDC_ISSUER: base,
    CSS_REDIS_CLIENT: '',
    XPOD_MODELS_DEV_URL: 'data:application/json,%7B%7D',
    ...(process.env.XPOD_NATIVE_VERIFY_RUNTIME_COMMAND
      ? { XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: process.env.XPOD_NATIVE_VERIFY_RUNTIME_COMMAND } : {}),
  },
});

const evidence: Record<string, unknown> = { base, platform: process.platform, nativeRuntime: process.env.XPOD_NATIVE_VERIFY_RUNTIME_COMMAND ? 'explicit' : 'installed' };
try {
  const account = await setupAccount(base, 'native-verify');
  if (!account) throw new Error('Account setup failed');
  writeFileSync(`${root}/account-private.json`, JSON.stringify(account), { mode: 0o600 });

  const session = await loginWithClientCredentials(account);
  const db = drizzle(session as never, {
    podUrl: account.podUrl,
    schema: { approval: approvalResource },
    autoConnect: false,
    resourcePreparation: 'off',
  });

  // Structured Pod writes land in by-line local RDF documents, so the id must
  // name a line-addressable document (the schema's own `{yyyy}/{MM}/{dd}.ttl#{key}` shape).
  const key = `native-verify-${Date.now()}`;
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '/');
  const id = `${day}.ttl#${key}`;
  await db.insert(approvalResource).values({
    id,
    session: `${account.podUrl}sessions/native-verify`,
    toolCallId: key,
    toolName: 'native.verify',
    target: account.podUrl,
    action: 'http://www.w3.org/ns/odrl/2/read',
    risk: 'low',
    status: 'pending',
    assignedTo: account.webId,
  });
  const iri = approvalResource.buildIri(account.podUrl, { id });
  evidence.insert = { id, iri };

  const found = await db.findByIri(approvalResource, iri);
  evidence.find = found ? { id: (found as { id?: string }).id, status: (found as { status?: string }).status } : null;

  // Product approval decision path: GET + conditional PUT of the whole document.
  const decision = await decideApprovalRequest({
    approval: iri,
    decisionBy: account.webId,
    decision: 'approved',
    authenticatedFetch: session.fetch,
  });
  const afterDecision = await db.findByIri(approvalResource, iri);
  evidence.productUpdate = { status: decision.status, rowStatus: (afterDecision as { status?: string } | null)?.status };

  // Generic drizzle PATCH update/delete must actually take effect: task/todo edits
  // and deletions use exactly these paths.
  try {
    await db.updateByIri(approvalResource, iri, { risk: 'medium' });
    const afterPatch = await db.findByIri(approvalResource, iri);
    evidence.drizzlePatchUpdate = { risk: (afterPatch as { risk?: string } | null)?.risk };
  } catch (error) {
    evidence.drizzlePatchUpdate = { error: error instanceof Error ? error.message : String(error) };
  }
  try {
    await db.deleteByIri(approvalResource, iri);
    const afterDelete = await db.findByIri(approvalResource, iri);
    evidence.drizzleDelete = { remaining: afterDelete ? 1 : 0 };
  } catch (error) {
    evidence.drizzleDelete = { error: error instanceof Error ? error.message : String(error) };
  }

  evidence.ok = Boolean(found)
    && (found as { status?: string }).status === 'pending'
    && decision.status === 'decided'
    && (afterDecision as { status?: string } | null)?.status === 'approved'
    && (evidence.drizzlePatchUpdate as { risk?: string }).risk === 'medium'
    && (evidence.drizzleDelete as { remaining?: number }).remaining === 0;

  await session.logout();
} catch (error) {
  evidence.ok = false;
  evidence.error = error instanceof Error ? error.message : String(error);
} finally {
  writeFileSync(`${root}/verify-result.json`, JSON.stringify(evidence, null, 2));
  console.log(`NATIVE_RDF_VERIFY ${JSON.stringify(evidence)}`);
  await runtime.stop();
}

if (evidence.ok !== true) process.exitCode = 1;
