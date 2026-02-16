/**
 * Admin DDNS API Handler (Local managed mode)
 */

import type { ServerResponse } from 'node:http';
import type { ApiServer, RouteHandler } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { DdnsManager } from '../../edge/DdnsManager';

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export function registerAdminDdnsRoutes(
  server: ApiServer,
  options: { ddnsManager?: DdnsManager },
): void {
  const ddnsStatusHandler: RouteHandler = async (
    _req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    try {
      const ddnsManager = options.ddnsManager;
      if (!ddnsManager) {
        sendJson(res, 200, {
          enabled: false,
          allocated: false,
          fqdn: null,
          baseUrl: '',
          mode: 'unknown',
          tunnelProvider: 'none',
          ipv4: null,
          ipv6: null,
          detail: 'DDNS is not enabled (missing XPOD_NODE_TOKEN).',
        });
        return;
      }

      const status = ddnsManager.getStatus();
      const allocated = Boolean(status.allocated);
      const fqdn = status.fqdn ?? null;

      sendJson(res, 200, {
        enabled: true,
        allocated,
        fqdn,
        baseUrl: fqdn ? ('https://' + fqdn + '/') : '',
        mode: status.mode,
        tunnelProvider: status.tunnelProvider,
        ipv4: status.ipv4 ?? null,
        ipv6: status.ipv6 ?? null,
        detail: allocated
          ? 'Domain allocated. Update CSS_BASE_URL and restart to apply.'
          : 'Allocating... try refresh later.',
      });
    } catch (_error) {
      sendJson(res, 500, { error: 'Failed to get ddns status' });
    }
  };

  const ddnsRefreshHandler: RouteHandler = async (
    _req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    try {
      const ddnsManager = options.ddnsManager;
      if (!ddnsManager) {
        sendJson(res, 200, { success: false, detail: 'DDNS is not enabled (missing XPOD_NODE_TOKEN).' });
        return;
      }

      await ddnsManager.runOnce();
      sendJson(res, 200, { success: true });
    } catch (_error) {
      sendJson(res, 500, { error: 'Failed to refresh ddns' });
    }
  };

  server.get('/api/admin/ddns', ddnsStatusHandler, { public: true });
  server.post('/api/admin/ddns/refresh', ddnsRefreshHandler, { public: true });
}
