import { BaseAiClientConfigAdapter } from './base-adapter';
import type { AiConnectionClientProfile, ClientVerification } from './types';
export interface PiConfigAdapterOptions {
    homeDir?: string;
}
export declare class PiConfigAdapter extends BaseAiClientConfigAdapter {
    private readonly settingsPath;
    private readonly modelsPath;
    constructor(options?: PiConfigAdapterOptions);
    protected project(profile: AiConnectionClientProfile, current: Map<string, string | undefined>): Promise<Map<string, string>>;
    protected verifyProjection(profile: AiConnectionClientProfile): Promise<ClientVerification>;
    protected restoreFile(filePath: string, current: string | undefined, original: string | undefined, originallyExisted: boolean): Promise<string | null>;
}
