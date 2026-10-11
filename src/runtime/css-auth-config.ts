import type { AuthMode } from '../authorization/AuthMode';

export function cssAuthModeConfigImports(authMode: AuthMode): string[] {
  switch (authMode) {
    case 'acl':
      return [
        'css:config/ldp/authorization/webacl.json',
        'css:config/util/auxiliary/acl.json',
      ];
    case 'allow-all':
      return [
        'css:config/ldp/authorization/allow-all.json',
        'css:config/util/auxiliary/empty.json',
      ];
    case 'acp':
    default:
      return [
        'css:config/ldp/authorization/acp.json',
        'css:config/util/auxiliary/acr.json',
      ];
  }
}

