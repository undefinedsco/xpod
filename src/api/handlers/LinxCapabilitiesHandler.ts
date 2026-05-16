import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import { PACKAGE_ROOT } from '../../runtime';

const LINX_LOCAL_ONBOARDING_CONTRACT = 'linx-local-onboarding/v1';

export function registerLinxCapabilitiesRoutes(server: ApiServer): void {
  server.get('/api/linx/capabilities', async (_request, response) => {
    sendJson(response, 200, {
      contract: LINX_LOCAL_ONBOARDING_CONTRACT,
      baseUrl: ensureTrailingSlash(process.env.CSS_BASE_URL || 'http://localhost:3000/'),
      version: getVersion(),
    });
  }, { public: true });
}

function getVersion(): string {
  try {
    const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(payload));
}
