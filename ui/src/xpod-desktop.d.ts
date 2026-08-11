export {};

declare global {
  interface XpodDesktopIdentityPayload {
    label: string;
    webId?: string;
    podUrl?: string;
  }

  var xpodDesktop: undefined | {
    setIdentity(identity: XpodDesktopIdentityPayload | null): void;
  };
}
