import { ForbiddenHttpError, MetadataParser } from '@solid/community-server';
import { ExternalLoginService } from './ExternalLoginService';

/** Keep browser mutations on the account authority, including same-site sibling origins. */
export class ExternalLoginRequestGuard extends MetadataParser {
  public constructor(private readonly service: ExternalLoginService) { super(); }

  public async handle({ request }: Parameters<MetadataParser['handle']>[0]): Promise<void> {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET')) return;
    const root = this.service.accountRoot;
    const path = new URL(request.url ?? '/', root).pathname;
    if (!path.startsWith(root.pathname)) return;
    const relative = path.slice(root.pathname.length).replace(/^interaction\/[^/]+\//u, '');
    const match = /^login\/([^/]+)\/(?:callback\/)?$/u.exec(relative);
    if (!match || !this.service.providers.has(match[1])) return;
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    if ((origin !== undefined && origin !== root.origin) || (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      throw new ForbiddenHttpError('EXTERNAL_LOGIN_SAME_ORIGIN_REQUIRED');
    }
    // Non-browser clients without Origin/Fetch Metadata retain the existing Account API contract.
  }
}
