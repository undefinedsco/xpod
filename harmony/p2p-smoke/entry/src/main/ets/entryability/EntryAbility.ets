import { UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { P2PSmokeRunner, SmokeConfig, SmokeResult } from '../p2p/P2PSmokeRunner';

const LOG_DOMAIN: number = 0x0001;
const LOG_TAG: string = 'XpodP2PSmoke';

function param(want: Want, key: string): string {
  const parameters = want.parameters ?? {};
  const value = parameters[key];
  return value === undefined || value === null ? '' : `${value}`;
}

export default class EntryAbility extends UIAbility {
  onCreate(want: Want): void {
    const config: SmokeConfig = {
      apiBaseUrl: param(want, 'xpod.p2p.apiBaseUrl'),
      nodeId: param(want, 'xpod.p2p.nodeId'),
      clientId: param(want, 'xpod.p2p.clientId'),
      resourceUrl: param(want, 'xpod.p2p.resourceUrl'),
      idpUrl: param(want, 'xpod.p2p.idpUrl'),
      storageUrl: param(want, 'xpod.p2p.storageUrl'),
      resourcePath: param(want, 'xpod.p2p.resourcePath'),
    };
    const runner = new P2PSmokeRunner(config);
    runner.run().then((result: SmokeResult) => {
      hilog.info(LOG_DOMAIN, LOG_TAG, `RESULT_JSON ${JSON.stringify(result)}`);
    }).catch((error: Error) => {
      hilog.error(LOG_DOMAIN, LOG_TAG, `RESULT_JSON ${JSON.stringify({ smokeOk: false, ok: false, error: error.message })}`);
    });
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index');
  }
}
