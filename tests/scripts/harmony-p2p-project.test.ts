import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const project = path.join(root, 'harmony/p2p-smoke');

describe('Harmony P2P smoke project', () => {
  it('declares a dedicated installable Harmony bundle with INTERNET permission', async () => {
    const appJson = await readFile(path.join(project, 'AppScope/app.json5'), 'utf8');
    const moduleJson = await readFile(path.join(project, 'entry/src/main/module.json5'), 'utf8');

    expect(appJson).toContain('com.undefineds.xpod.p2psmoke');
    expect(moduleJson).toContain('EntryAbility');
    expect(moduleJson).toContain('ohos.permission.INTERNET');
  });

  it('implements native HTTP signaling, raw TCP data plane, and RESULT_JSON hilog output', async () => {
    const smoke = await readFile(path.join(project, 'entry/src/main/ets/p2p/P2PSmokeRunner.ets'), 'utf8');

    expect(smoke).toContain("import { http, socket } from '@kit.NetworkKit'");
    expect(smoke).toContain('POST');
    expect(smoke).toContain('/v1/signal/nodes/');
    expect(smoke).toContain('constructP2PHttpRequest');
    expect(smoke).toContain('socket.constructTCPSocketInstance');
    expect(smoke).toContain('clientAddress');
    expect(smoke).toContain('signal-observed');
    expect(smoke).toContain('putStatus');
  });

  it('reads launcher parameters from UIAbility want parameters', async () => {
    const ability = await readFile(path.join(project, 'entry/src/main/ets/entryability/EntryAbility.ets'), 'utf8');

    expect(ability).toContain('want.parameters');
    expect(ability).toContain('xpod.p2p.apiBaseUrl');
    expect(ability).toContain('P2PSmokeRunner');
    expect(ability).toContain('RESULT_JSON');
  });
});
