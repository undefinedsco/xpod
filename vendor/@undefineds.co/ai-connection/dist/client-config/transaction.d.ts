import type { ConfigWrite } from './types';
export interface AiClientConfigTransactionDependencies {
    rename?: (from: string, to: string) => Promise<void>;
}
export declare class AiClientConfigTransaction {
    private readonly rename;
    constructor(dependencies?: AiClientConfigTransactionDependencies);
    apply(writes: ConfigWrite[]): Promise<void>;
    private preparePath;
    private rejectSymlink;
    private snapshot;
    private stage;
    private writeNewFile;
    private rollback;
    private syncDirectory;
    private exists;
}
