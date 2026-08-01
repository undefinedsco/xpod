export type PodRuntimeFetch = typeof fetch;
export type PodRuntimeAdapter<Database> = {
    discoverPod(args: {
        webId: string;
        fetch: PodRuntimeFetch;
        signal: AbortSignal;
        isCurrent(): boolean;
    }): Promise<string> | string;
    openDatabase(args: {
        webId: string;
        podUrl: string;
        fetch: PodRuntimeFetch;
        signal: AbortSignal;
        isCurrent(): boolean;
    }): Promise<Database> | Database;
    hydrateCollections(args: {
        webId: string;
        podUrl: string;
        database: Database;
        signal: AbortSignal;
        isCurrent(): boolean;
    }): Promise<void> | void;
};
export type OpenPodRuntime<Database> = {
    readonly webId: string;
    readonly podUrl: string;
    readonly database: Database;
    readonly collections: 'ready';
};
export type CreatePodRuntimeOptions<Database> = {
    adapter: PodRuntimeAdapter<Database>;
};
export type PodRuntimeClearIdentity = string | {
    webId: string;
    podUrl?: string;
};
export type PodRuntime<Database> = {
    open(args: {
        webId: string;
        fetch: PodRuntimeFetch;
    }): Promise<OpenPodRuntime<Database>>;
    clear(identity?: PodRuntimeClearIdentity): void;
    dispose(): void;
};
export declare function createPodRuntime<Database>(options: CreatePodRuntimeOptions<Database>): PodRuntime<Database>;
