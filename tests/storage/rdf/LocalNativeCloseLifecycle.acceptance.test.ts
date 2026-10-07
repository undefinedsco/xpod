// Root-owned public native IPC lifecycle test, not production QLever/RDF/Gateway acceptance.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalQleverNativeSparqlClient } from '../../../src/storage/rdf/LocalQleverNativeSparqlClient';

describe('Root: concurrent native close waits for the same owned execution', () => {
  it('does not report a second close complete while the owned native child is still alive', async () => {
    const parent = path.resolve('.test-data/solid-multiparty-acceptance/provider-b/root-review/native-close-fixtures');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'root-'));
    const pidFile = path.join(directory, 'owned.pid');
    const releaseFile = path.join(directory, 'release');
    const producer = path.join(directory, 'controlled-native-producer.cjs');
    await writeFile(producer, `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write(JSON.stringify({ type: 'ready', backend: 'sqlite', abiVersion: 1, physicalBackendAbiVersion: 7 }) + '\\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'shutdown') {
    const wait = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(releaseFile)})) {
        clearInterval(wait);
        process.exit(0);
      }
    }, 5);
  }
});
`);
    const client = new LocalQleverNativeSparqlClient({ command: process.execPath, args: [producer],
      expectedNativeSparqlAbiVersion: 1, expectedPhysicalBackendAbiVersion: 7 });
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      await client.start();
      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();
      first = client.close();
      let firstDone = false;
      void first.then(() => { firstDone = true; });
      second = client.close();
      let secondDone = false;
      void second.then(() => { secondDone = true; });
      // Only Promise turns: the child cannot be released by the controlled producer yet.
      await Promise.resolve();
      await Promise.resolve();
      expect(() => process.kill(pid, 0), 'the owned producer must still be live at the observation').not.toThrow();
      expect.soft(firstDone, 'the first close must still be awaiting the owned child').toBe(false);
      expect.soft(secondDone, 'a second close must await the same outstanding drain').toBe(false);
      await writeFile(releaseFile, 'release\n');
      await Promise.all([first, second]);
      expect(() => process.kill(pid, 0), 'completed close must have reaped its owned child').toThrow();
    } finally {
      await writeFile(releaseFile, 'release\n');
      await Promise.all([first ?? client.close(), second ?? Promise.resolve()]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
