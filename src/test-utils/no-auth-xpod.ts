/**
 * 无鉴权版本的 xpod 启动器
 * 使用进程内 lib 方式启动完整 Xpod（CSS + API + Gateway）
 */
import { startXpodRuntime } from '../runtime/XpodRuntime';

export interface NoAuthXpodOptions {
  port?: number;
  baseUrl?: string;
  rootFilePath?: string;
  sparqlEndpoint?: string;
  logLevel?: string;
}

export async function startNoAuthXpod(options: NoAuthXpodOptions = {}): Promise<{
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const runtime = await startXpodRuntime({
    mode: 'local',
    open: true,
    transport: options.port ? 'port' : 'auto',
    gatewayPort: options.port,
    baseUrl: options.baseUrl,
    rootFilePath: options.rootFilePath,
    sparqlEndpoint: options.sparqlEndpoint,
    logLevel: options.logLevel,
  });

  return {
    baseUrl: runtime.baseUrl,
    stop: runtime.stop,
  };
}
