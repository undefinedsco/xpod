import type { ServerResponse } from 'node:http';
import type { RouteHandler } from '../ApiServer';
import { CALLER_OWNER_MISMATCH, CALLER_POD_ACCESS_UNAVAILABLE } from '../ai-gateway/auth/CallerPodAccess';
import { isPodAccessFailure } from '../ai-gateway/pod/OwnerPodAccess';

/** The wire code callers already report when Xpod cannot open the Pod for them. */
export const SERVICE_ACCESS_MISSING = 'service_access_missing';

export interface PodAccessFailureResponse {
  status: number;
  error: string;
}

/**
 * Status and code for a Pod access failure, or undefined when the error is something else.
 *
 * A Pod-backed surface that cannot reach the Pod has to say so. Answering an empty list instead
 * leaves the caller with a state it cannot act on, and the reason codes exist precisely so the
 * caller can tell "sign in" from "grant this app access to your Pod".
 */
export function podAccessFailureResponse(error: unknown): PodAccessFailureResponse | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!isPodAccessFailure(message)) {
    return undefined;
  }
  if (message.startsWith(CALLER_POD_ACCESS_UNAVAILABLE)) {
    return { status: 401, error: 'authentication_required' };
  }
  if (message.startsWith(CALLER_OWNER_MISMATCH)) {
    return { status: 403, error: 'pod_owner_mismatch' };
  }
  return { status: 403, error: SERVICE_ACCESS_MISSING };
}

/** Answer with the mapped failure. Returns false when the error is not a Pod access failure. */
export function sendPodAccessFailure(response: ServerResponse, error: unknown): boolean {
  const mapped = podAccessFailureResponse(error);
  if (!mapped) {
    return false;
  }
  response.statusCode = mapped.status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ error: mapped.error }));
  return true;
}

/**
 * Wrap a route so a Pod access failure answers with the mapped status instead of a generic 500.
 *
 * Anything else keeps propagating, so unrelated bugs are not reported as missing Pod access.
 */
export function guardPodAccessRoute(handler: RouteHandler): RouteHandler {
  return async(request, response, params) => {
    try {
      await handler(request, response, params);
    } catch (error) {
      if (!sendPodAccessFailure(response, error)) {
        throw error;
      }
    }
  };
}
