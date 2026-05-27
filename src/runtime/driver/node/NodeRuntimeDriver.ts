import { nodeRuntimeHost } from '../../host/node/NodeRuntimeHost';
import { nodeRuntimePlatform } from '../../platform/node/NodeRuntimePlatform';
import { communitySolidServerCssRunner } from '../../runner/node/CommunitySolidServerCssRunner';
import { nodeApiRuntimeRunner } from '../../runner/node/NodeApiRuntimeRunner';
import { nodeGatewayRuntimeRunner } from '../../runner/node/NodeGatewayRuntimeRunner';
import type { RuntimeDriver } from '../types';

export class NodeRuntimeDriver implements RuntimeDriver {
  public readonly name = 'node';
  public readonly host = nodeRuntimeHost;
  public readonly platform = nodeRuntimePlatform;
  public readonly cssRunner = communitySolidServerCssRunner;
  public readonly apiRunner = nodeApiRuntimeRunner;
  public readonly gatewayRunner = nodeGatewayRuntimeRunner;
}

export const nodeRuntimeDriver = new NodeRuntimeDriver();
