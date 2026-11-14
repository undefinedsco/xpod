import { describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ModuleStore } from '../../packages/xpod-cli/src/module-store';
import { MODULE_CHAIN_CASE, artifactFetch, hashBytes, hashFile, isolatedModuleEnvironment, readModuleAdmissionInputs, verifyBoundFile, type ModuleAdmissionInputs } from '../../scripts/agentfs-native-ci/mounted/module-admission';
import { observeChildLifecycle, probeOwnedGroup, reapOwnedGroup } from '../../scripts/agentfs-native-ci/mounted/platform-admission';
import { MODULE_CHAIN_STAGES, MODULE_CHAIN_ERROR_CODES } from '../../scripts/agentfs-native-ci/mounted/prepare-module-inputs';
import { observeKernelMounts } from './support/mountCleanup';
import { startPodContractServer } from './support/podContractServer';

describe('installed module admission nonmount negative contracts', () => {
  it('rejects artifact mutation, links, and absent external byte authority', () => {
    const parent = path.resolve('.test-data/module-admission-negative'); mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = mkdtempSync(path.join(parent, 'case-')); const file = path.join(root, 'artifact'); writeFileSync(file, 'original');
    try {
      const bound = { path: file, sha256: hashFile(file) }; verifyBoundFile(bound);
      const alias = path.join(root, 'alias'); symlinkSync(file, alias);
      expect(() => verifyBoundFile({ path: alias, sha256: bound.sha256 })).toThrow('identity mismatch');
      writeFileSync(file, 'changed'); expect(() => verifyBoundFile(bound)).toThrow('identity mismatch');
      expect(() => readModuleAdmissionInputs(file, '0'.repeat(64))).toThrow('identity mismatch');
      expect(() => verifyBoundFile({ path: '../artifact', sha256: bound.sha256 })).toThrow('identity mismatch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects an old preview or contradictory source authority before installation', () => {
    const parent = path.resolve('.test-data/module-admission-negative'); mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = mkdtempSync(path.join(parent, 'case-')); const file = path.join(root, 'inputs.json');
    try {
      for (const input of [{ schemaVersion: 1, target: 'linux-arm64', module: { name: 'xpod-cli-preview' } },
        { schemaVersion: 1, target: 'linux-arm64', moduleSourceSHA: '1'.repeat(40), nativeBuildSourceSHA: '2'.repeat(40), core: { sourceSHA: '3'.repeat(40) } }]) {
        writeFileSync(file, JSON.stringify(input)); expect(() => readModuleAdmissionInputs(file, hashFile(file))).toThrow('authority is invalid');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('offline transport rejects alternate metadata and downloads rather than contacting the network', async () => {
    const input = { target: 'linux-arm64', module: { name: '@undefineds.co/xpod-afs-linux-arm64', version: '0.1.0', integrity: 'sha512-untrusted' } } as ModuleAdmissionInputs;
    const request = artifactFetch(input);
    await expect(request('https://example.invalid/unbound.tgz')).rejects.toThrow('unbound URL');
    await expect(request('https://registry.npmjs.org/%40undefineds.co%2Fxpod-afs-linux-arm64/latest')).rejects.toThrow('unbound URL');
  });
  it('consumer credentials and runtime injection options come only from its private home', () => {
    const env = isolatedModuleEnvironment('/owned/private/home', '/owned/current/evidence');
    expect(env.HOME).toBe('/owned/private/home'); expect(env.SOLID_HOME).toBe('/owned/private/home/.solid');
    expect(env.XPOD_MOUNTED_EVIDENCE).toBe('/owned/current/evidence');
    for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'BUN_OPTIONS', 'XPOD_AGENT_FS_ACCESS_TOKEN', 'XPOD_AGENTFS_TOKEN', 'CLIENT_SECRET']) expect(env[name]).toBeUndefined();
  });
  it.each(['bun', 'node'])('%s: actual failed bundled CLI closes and writes a private rejection receipt without exposing input bytes', async (runtimeName) => {
    const parent = path.resolve('.test-data/module-admission-negative'); mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = mkdtempSync(path.join(parent, 'case-')); const input = path.join(root, 'inputs.json'); writeFileSync(input, 'private-fixture-secret-marker', { mode: 0o600 });
    let child: ReturnType<typeof spawn> | undefined;
    let lifecycle: ReturnType<typeof observeChildLifecycle> | undefined;
    try {
      const fixture = process.env.XPOD_AGENTFS_ADMISSION_FIXTURE;
      let driver: string; let executable: string;
      if (fixture !== undefined) {
        const bound = JSON.parse(fixture) as Pick<ModuleAdmissionInputs, 'driver' | 'runtimes'>;
        verifyBoundFile(bound.driver); verifyBoundFile(bound.runtimes.node); verifyBoundFile(bound.runtimes.bun);
        driver = bound.driver.path; executable = bound.runtimes[runtimeName as 'node' | 'bun'].path;
      } else {
        if (process.env.XPOD_AGENTFS_MODULE_ENTRY !== undefined) throw new Error('mounted admission fixture authority missing');
        const tool = (name: string): string => {
          const filename = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
          if (!path.isAbsolute(filename)) throw new Error('negative CLI fixture runtime is not absolute');
          return filename;
        };
        executable = tool(runtimeName); driver = path.join(root, 'module-admission.mjs');
        const source = fileURLToPath(new URL('../../scripts/agentfs-native-ci/mounted/module-admission.ts', import.meta.url));
        const build = spawn(tool('bun'), ['build', source, '--target=node', '--format=esm', '--outfile', driver], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        const buildLifecycle = observeChildLifecycle(build); const buildRaw: Buffer[] = [];
        build.stdout.on('data', (chunk: Buffer) => buildRaw.push(chunk)); build.stderr.on('data', (chunk: Buffer) => buildRaw.push(chunk));
        try {
          const fact = await buildLifecycle.wait(30_000);
          const absent = await reapOwnedGroup(build.pid, 5000);
          if (fact.state !== 'closed' || fact.code !== 0 || fact.signal !== null || !absent) {
            throw new Error(`negative CLI fixture compile failed: ${JSON.stringify({ fact, groupAbsent: absent, outputSHA256: hashBytes(Buffer.concat(buildRaw)) })}`);
          }
        } finally { await reapOwnedGroup(build.pid, 5000); await buildLifecycle.waitClose(5000); }
      }
      child = spawn(executable, [driver, '--inputs', input, '--inputs-sha256', '0'.repeat(64), '--runtime', 'node'],
        { cwd: root, env: { ...isolatedModuleEnvironment(root), PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      lifecycle = observeChildLifecycle(child); const raw: Buffer[] = [];
      child.stdout!.on('data', (chunk: Buffer) => raw.push(chunk)); child.stderr!.on('data', (chunk: Buffer) => raw.push(chunk));
      const fact = await lifecycle.wait(15_000); expect(fact).toEqual({ state: 'closed', code: 70, signal: null });
      expect(await reapOwnedGroup(child.pid, 5000)).toBe(true);
      expect(Buffer.concat(raw).toString()).not.toContain('private-fixture-secret-marker');
      const evidenceParent = path.join(root, '.test-data/module-admission-preflight'); const failures = readdirSync(evidenceParent); expect(failures).toHaveLength(1);
      const receipt = JSON.parse(readFileSync(path.join(evidenceParent, failures[0], 'module-admission-failure.safe.json'), 'utf8'));
      expect(receipt).toMatchObject({ status: 'failed', stage: 'inputs', accepted: false, nativeReceiptPresent: null, mountedReceiptPresent: null });
    } finally { if (child) await reapOwnedGroup(child.pid, 5000); if (lifecycle) await lifecycle.waitClose(5000); rmSync(root, { recursive: true, force: true }); }
  });
});

const enabled = process.env.XPOD_AGENTFS_MODULE_ENTRY !== undefined;
describe.runIf(enabled)('actual installed npm AFS module mount chain', () => {
  it(MODULE_CHAIN_CASE, async () => {
    const evidence = process.env.XPOD_AGENTFS_MODULE_EVIDENCE!;
    const launcher = process.env.XPOD_AGENTFS_TEST_CLI!;
    const entry = process.env.XPOD_AGENTFS_MODULE_ENTRY!;
    const runtime = process.env.XPOD_AGENTFS_MODULE_RUNTIME!;
    const helper = process.env.XPOD_AGENTFS_HELPER!;
    const storeRoot = process.env.XPOD_AGENTFS_MODULE_STORE!;
    for (const filename of [launcher, entry, runtime, helper]) expect(path.isAbsolute(filename) && existsSync(filename)).toBe(true);
    const scene = mkdtempSync(path.join(evidence, 'module-chain-')); const mountpoint = path.join(scene, 'mnt'); const session = path.join(scene, 'session');
    mkdirSync(mountpoint, { mode: 0o700 }); mkdirSync(session, { mode: 0o700 });
    expect(observeKernelMounts(scene)).toBe('absent');
    const token = randomBytes(32).toString('hex'); const clientId = randomBytes(16).toString('hex'); const clientSecret = randomBytes(32).toString('hex');
    const pod = await startPodContractServer({ token, files: { 'alpha.txt': 'AUTHENTICATED_MODULE_READ\n' }, scratchDir: scene });
    let authExchanges = 0; let issuerOrigin = '';
    const issuer = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ token_endpoint: `${issuerOrigin}/token` })); return; }
      if (req.url !== '/token' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      let body = ''; req.on('data', chunk => { body += String(chunk); }); req.on('end', () => {
        const fields = new URLSearchParams(body);
        if (fields.get('grant_type') !== 'client_credentials' || fields.get('client_id') !== clientId || fields.get('client_secret') !== clientSecret) { res.writeHead(401); res.end(); return; }
        authExchanges++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }));
      });
    });
    await new Promise<void>(resolve => issuer.listen(0, '127.0.0.1', resolve));
    issuerOrigin = `http://127.0.0.1:${(issuer.address() as { port: number }).port}`;
    const solidHome = process.env.SOLID_HOME!;
    if (!solidHome || !path.isAbsolute(solidHome) || solidHome !== path.join(process.env.HOME!, '.solid')) throw new Error('private module credential home missing');
    const authDir = path.join(solidHome, 'auth'); mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(authDir, 'credentials.json'), JSON.stringify({ url: issuerOrigin, webId: `${pod.podRoot}profile/card#me`, authType: 'client_credentials', secrets: { clientId, clientSecret } }), { flag: 'wx', mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ...process.env, SOLID_HOME: solidHome }; delete env.XPOD_AGENT_FS_ACCESS_TOKEN; delete env.XPOD_AGENTFS_TOKEN;
    const children: Record<string, unknown>[] = []; let count = 0; const ownedPids: number[] = []; const ownedGroups: number[] = [];
    let attempted = false; let cleanupVerified = false; let chainOperationsCompleted = false;
    let primaryFailureObserved = false; let primaryCause: unknown;
    let stage: typeof MODULE_CHAIN_STAGES[number] = 'mount';
    let proxyIdentityObserved = false; let nativeIdentityObserved = false; let unmountClosedSuccessfully = false;
    const collectOwnerIdentities = (): void => {
      try {
        const owner = JSON.parse(readFileSync(path.join(session, 'proxy-owner.json'), 'utf8')) as { pid?: number };
        if (owner.pid && Number.isSafeInteger(owner.pid) && owner.pid > 0) { ownedPids.push(owner.pid); proxyIdentityObserved = true; }
      } catch { /* missing/malformed stays unknown */ }
      try {
        const owner = JSON.parse(readFileSync(path.join(session, '.nfs-runtime/owner.json'), 'utf8')) as { runtime?: { pid?: number }; closed?: { pid?: number } };
        if (owner.runtime?.pid && Number.isSafeInteger(owner.runtime.pid) && owner.runtime.pid > 0) {
          ownedPids.push(owner.runtime.pid); nativeIdentityObserved = true;
          if (owner.closed?.pid && Number.isSafeInteger(owner.closed.pid) && owner.closed.pid > 0) ownedPids.push(owner.closed.pid);
        }
      } catch { /* missing/malformed stays unknown */ }
    };
    const run = async (command: string, args: string[], timeout = 30_000) => {
      const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      if (child.pid) ownedGroups.push(child.pid);
      const lifecycle = observeChildLifecycle(child); const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      let fact = await lifecycle.wait(timeout);
      // A successful mount deliberately leaves supervised daemons alive. Do not
      // turn the direct-child close boundary into a blanket daemon kill.
      if (fact.state !== 'closed') { await reapOwnedGroup(child.pid, 15_000); fact = await lifecycle.waitClose(15_000); }
      const groupState = probeOwnedGroup(child.pid);
      const out = Buffer.concat(stdout); const err = Buffer.concat(stderr); const prefix = path.join(scene, `child-${++count}`);
      writeFileSync(`${prefix}.stdout.raw.log`, out, { flag: 'wx', mode: 0o600 }); writeFileSync(`${prefix}.stderr.raw.log`, err, { flag: 'wx', mode: 0o600 });
      children.push({ command, args, ...fact, lifecycle: lifecycle.facts(), groupStateAfterClose: groupState, stdoutSHA256: hashBytes(out), stderrSHA256: hashBytes(err), rawClosedBeforeHash: fact.state === 'closed' });
      if (fact.state !== 'closed' || fact.code !== 0 || fact.signal !== null) throw new Error('actual module chain command did not close successfully');
      return out.toString('utf8');
    };
    const waitAbsent = async (pid: number) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return true; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    };
    try {
      attempted = true;
      await run(launcher, ['afs', 'mount', '--pod-root', pod.podRoot, '--mountpoint', mountpoint, '--backend', process.env.XPOD_MOUNTED_BACKEND!, '--session-dir', session, '--json'], 90_000);
      stage = 'kernel-identity';
      expect(observeKernelMounts(mountpoint)).toBe('mounted');
      collectOwnerIdentities();
      const proxyOwnerPath = path.join(session, 'proxy-owner.json'); const runtimeOwnerPath = path.join(session, '.nfs-runtime/owner.json');
      stage = 'proxy-identity';
      const proxyPid = JSON.parse(readFileSync(proxyOwnerPath, 'utf8')).pid as number;
      stage = 'native-identity';
      const nativeOwner = JSON.parse(readFileSync(runtimeOwnerPath, 'utf8')) as { runtime?: { pid: number }; closed?: { pid: number } };
      const nativePid = nativeOwner.runtime?.pid;
      if (!Number.isSafeInteger(proxyPid) || !nativePid || !Number.isSafeInteger(nativePid)) throw new Error('actual module daemon identities missing');
      ownedPids.push(proxyPid, nativePid); if (nativeOwner.closed?.pid) ownedPids.push(nativeOwner.closed.pid);
      const proxyCommand = execFileSync('/bin/ps', ['-p', String(proxyPid), '-o', 'command='], { encoding: 'utf8' });
      expect(proxyCommand).toContain(entry); expect(proxyCommand).toContain('proxy');
      const nativeCommand = execFileSync('/bin/ps', ['-p', String(nativePid), '-o', 'command='], { encoding: 'utf8' }); expect(nativeCommand).toContain(helper);
      stage = 'read';
      expect(await run(process.execPath, ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))", path.join(mountpoint, 'alpha.txt')])).toBe('AUTHENTICATED_MODULE_READ\n');
      expect(authExchanges).toBeGreaterThan(0); expect(pod.history.some(row => row.resource === 'alpha.txt' && row.status === 200)).toBe(true);
      stage = 'writeback';
      await run(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],'MODULE_WRITE\\n')", path.join(mountpoint, 'alpha.txt')]);
      await run(launcher, ['afs', 'commit', '--pod-root', pod.podRoot, '--session-dir', session, '--json']); expect(pod.readBody('alpha.txt')).toBe('MODULE_WRITE\n');
      stage = 'unmount';
      await run(launcher, ['afs', 'unmount', '--mountpoint', mountpoint, '--session-dir', session, '--json'], 90_000); attempted = false; unmountClosedSuccessfully = true;
      stage = 'final-verification';
      expect(observeKernelMounts(scene)).toBe('absent');
      for (const pid of new Set(ownedPids)) expect(await waitAbsent(pid)).toBe(true);
      expect(existsSync(path.join(session, 'proxy.json'))).toBe(false);
      expect((await new ModuleStore({ root: storeRoot }).current('afs'))?.id).toBe('afs');
      chainOperationsCompleted = true;
      writeFileSync(path.join(evidence, 'module-chain.safe.json'), JSON.stringify({ status: 'executed', entry, entrySHA256: hashFile(entry), helper, helperSHA256: hashFile(helper),
        runtime, runtimeSHA256: hashFile(runtime), launcherSHA256: hashFile(launcher), authExchanges, actualAuthenticatedRead: true, actualConditionalWriteback: true,
        proxyCommandSHA256: hashBytes(proxyCommand), nativeCommandSHA256: hashBytes(nativeCommand), proxyOwnerSHA256: hashFile(proxyOwnerPath),
        ownedPids, daemonAbsenceProven: true, kernelAbsent: true, children }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (cause) {
      primaryFailureObserved = true; primaryCause = cause;
      const code = (cause as NodeJS.ErrnoException)?.code;
      const errorCode = MODULE_CHAIN_ERROR_CODES.includes(code as typeof MODULE_CHAIN_ERROR_CODES[number]) ? code : 'unknown';
      try { writeFileSync(path.join(evidence, 'module-chain-failure.safe.json'), JSON.stringify({
        backend: process.env.XPOD_MOUNTED_BACKEND === 'fuse' ? 'fuse' : 'nfs', stage,
        errorCode, errorSHA256: hashBytes(String(cause)), primaryFailureObserved,
      }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      } catch (diagnosticCause) { throw new AggregateError([cause, diagnosticCause], 'module chain failed and diagnostic persistence failed'); }
      throw cause;
    } finally {
      try {
        collectOwnerIdentities();
        if (attempted) {
          try { await run(launcher, ['afs', 'unmount', '--mountpoint', mountpoint, '--session-dir', session, '--json'], 90_000); unmountClosedSuccessfully = true; }
          catch { /* retained below */ }
        }
        collectOwnerIdentities();
        const kernelAbsent = observeKernelMounts(scene) === 'absent';
        const identitiesKnown = proxyIdentityObserved && nativeIdentityObserved && ownedPids.length > 0;
        const daemonsAbsent = identitiesKnown && (await Promise.all([...new Set(ownedPids)].map(waitAbsent))).every(Boolean);
        const groupsDeadline = Date.now() + 15_000;
        while (Date.now() < groupsDeadline && ownedGroups.some(pgid => probeOwnedGroup(pgid) !== 'absent')) await new Promise(resolve => setTimeout(resolve, 50));
        const groupsAbsent = ownedGroups.every(pgid => probeOwnedGroup(pgid) === 'absent');
        cleanupVerified = chainOperationsCompleted && unmountClosedSuccessfully && kernelAbsent && daemonsAbsent && groupsAbsent;
        writeFileSync(path.join(evidence, 'module-chain-cleanup.safe.json'), JSON.stringify({ cleanupVerified, kernelAbsent, daemonsAbsent,
          groupsAbsent, ownedGroups, identitiesKnown, proxyIdentityObserved, nativeIdentityObserved, unmountClosedSuccessfully,
          ownedPids: [...new Set(ownedPids)], sceneRetained: !cleanupVerified, children }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        issuer.closeAllConnections(); await new Promise<void>(resolve => issuer.close(() => resolve())); await pod.close();
        if (!primaryFailureObserved && (!unmountClosedSuccessfully || !kernelAbsent || !daemonsAbsent || !groupsAbsent)) throw new Error('module mount cleanup unresolved; owned scene retained');
        // Credentials/raw remain private in this owned evidence scene; never upload it wholesale.
      } catch (cleanupCause) {
        if (primaryFailureObserved) throw new AggregateError([primaryCause, cleanupCause], 'module chain and cleanup failed');
        throw cleanupCause;
      }
    }
  }, 360_000);
});
