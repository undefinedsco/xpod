import { type IHandleIncomingRedirectOptions, type ILoginInputOptions, type ILogoutOptions, type ISessionEventListener, type ISessionInfo } from '@inrupt/solid-client-authn-browser';
export type SolidSessionSnapshot = {
    status: 'initializing';
    webId?: undefined;
    error?: undefined;
} | {
    status: 'anonymous';
    webId?: undefined;
    error?: undefined;
} | {
    status: 'authenticated';
    webId: string;
    error?: undefined;
} | {
    status: 'error';
    webId?: string;
    error: Error;
};
export type SolidSessionListener = (snapshot: SolidSessionSnapshot) => void;
export type SolidSessionAdapter = {
    readonly info: Pick<ISessionInfo, 'isLoggedIn' | 'webId'>;
    events: ISessionEventListener;
    fetch: typeof fetch;
    handleIncomingRedirect(options?: string | IHandleIncomingRedirectOptions): Promise<Pick<ISessionInfo, 'isLoggedIn' | 'webId'> | undefined>;
    login(options: ILoginInputOptions): Promise<void>;
    logout(options?: ILogoutOptions): Promise<void>;
};
export type SolidSessionRuntime = {
    readonly fetch: typeof fetch;
    getSnapshot(): SolidSessionSnapshot;
    initialize(options?: {
        restorePreviousSession?: boolean;
    }): Promise<SolidSessionSnapshot>;
    login(options: ILoginInputOptions): Promise<void>;
    logout(options?: ILogoutOptions): Promise<void>;
    subscribe(listener: SolidSessionListener): () => void;
    dispose(): void;
};
export type CreateSolidSessionRuntimeOptions = {
    session?: SolidSessionAdapter;
};
export declare function createSolidSessionRuntime(options?: CreateSolidSessionRuntimeOptions): SolidSessionRuntime;
