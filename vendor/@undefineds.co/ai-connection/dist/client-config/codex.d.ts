import { BaseAiClientConfigAdapter } from './base-adapter';
import type { AiConnectionClientProfile, ClientVerification } from './types';
export interface CodexConfigAdapterOptions {
    homeDir?: string;
}
export declare class CodexConfigAdapter extends BaseAiClientConfigAdapter {
    private readonly configPath;
    private readonly authPath;
    constructor(options?: CodexConfigAdapterOptions);
    protected project(profile: AiConnectionClientProfile, current: Map<string, string | undefined>): Promise<Map<string, string>>;
    protected verifyProjection(profile: AiConnectionClientProfile): Promise<ClientVerification>;
    protected restoreFile(filePath: string, current: string | undefined, original: string | undefined, originallyExisted: boolean): Promise<string | null>;
    private removeManagedBlock;
}
