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
    setWindowMode?(mode: 'auth' | 'workspace'): void;
    /** Available only in desktop lifecycle acceptance runs. */
    closeWindowForAcceptance?(): void;
    /** Available only in desktop lifecycle acceptance runs. */
    quitForAcceptance?(): void;
  };
}
