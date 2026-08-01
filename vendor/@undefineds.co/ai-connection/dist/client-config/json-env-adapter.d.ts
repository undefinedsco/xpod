import { BaseAiClientConfigAdapter } from './base-adapter';
import type { AiConnectionClientProfile, ClientVerification } from './types';
type EnvProjection = (profile: AiConnectionClientProfile) => Record<string, string>;
declare abstract class JsonEnvAdapter extends BaseAiClientConfigAdapter {
    private readonly envProjection;
    protected readonly settingsPath: string;
    protected constructor(client: string, settingsPath: string, envProjection: EnvProjection);
    protected project(profile: AiConnectionClientProfile, current: Map<string, string | undefined>): Promise<Map<string, string>>;
    protected verifyProjection(profile: AiConnectionClientProfile): Promise<ClientVerification>;
    protected restoreFile(_filePath: string, current: string | undefined, original: string | undefined, originallyExisted: boolean): Promise<string | null>;
}
export interface JsonEnvConfigAdapterOptions {
    homeDir?: string;
}
export declare class ClaudeCodeConfigAdapter extends JsonEnvAdapter {
    constructor(options?: JsonEnvConfigAdapterOptions);
}
export declare class CodeBuddyConfigAdapter extends JsonEnvAdapter {
    constructor(options?: JsonEnvConfigAdapterOptions);
}
export {};
