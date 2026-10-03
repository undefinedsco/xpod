/** Keep destructive provisioning requests on the CSS data/identity lifecycle. */
export function podDeletionRouteName(method: string | undefined, requestUrl: string): string | undefined {
  if (method !== 'DELETE') { return; }
  const pathname = requestUrl.split('?', 1)[0];
  return /^\/provision\/pods\/([a-zA-Z0-9_-]{1,64})$/u.exec(pathname)?.[1];
}
