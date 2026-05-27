import type { RuntimeHost } from '../host/types';
import type { RuntimePlatform } from '../platform/types';
import type { ApiRuntimeRunner, CssRuntimeRunner, GatewayRuntimeRunner } from '../runner/types';

export interface RuntimeDriver {
  readonly name: string;
  readonly host: RuntimeHost;
  readonly platform: RuntimePlatform;
  readonly cssRunner: CssRuntimeRunner;
  readonly apiRunner: ApiRuntimeRunner;
  readonly gatewayRunner: GatewayRuntimeRunner;
}
