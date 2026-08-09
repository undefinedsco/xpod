export {};

declare global {
  var xpodDesktop: undefined | {
    setIdentity(identity: { label: string; webId?: string; podUrl?: string } | null): void;
  };
}
