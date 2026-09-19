/**
 * Resolve the Pod address this app can actually reach.
 *
 * A Pod is always served by the same authority that serves the app, so the
 * runtime's canonical Pod URL differs from it only by origin. In the desktop
 * shell that canonical origin is a public address the runtime maps to loopback
 * for its own processes (socket origin shims), but the renderer cannot resolve
 * it: opening it there hands the request to the system browser, which fails
 * wherever the node has no working public route.
 */
export function reachablePodUrl(podUrl: string | undefined, origin: string): string | undefined {
  if (!podUrl) return undefined;
  try {
    return new URL(new URL(podUrl).pathname, origin).toString();
  } catch {
    return undefined;
  }
}
