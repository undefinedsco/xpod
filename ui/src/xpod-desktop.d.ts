export {};

declare global {
  interface XpodDesktopIdentityPayload {
    label: string;
    webId?: string;
    podUrl?: string;
  }

  var xpodDesktop: undefined | {
    platform?: 'darwin' | 'linux' | 'win32';
    setIdentity(identity: XpodDesktopIdentityPayload | null): void;
    /** Return to the shell's configured product entry without accepting a page URL. */
    cancelLogin?(): Promise<void>;
    setWindowMode?(mode: 'auth' | 'account' | 'workspace'): void;
    onNavigate?(navigate: (route: string) => void): () => void;
    /** Available only in desktop lifecycle acceptance runs. */
    closeWindowForAcceptance?(): void;
    /** Available only in desktop lifecycle acceptance runs. */
    quitForAcceptance?(): void;
  };
}
