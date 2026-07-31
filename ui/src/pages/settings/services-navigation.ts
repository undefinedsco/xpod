import { Activity, Database, ScrollText, Settings } from 'lucide-react';
import type { ComponentType } from 'react';

export type ServiceSectionId = 'runtime' | 'logs' | 'rdf' | 'configuration';

export interface ServiceNavigationItem {
  id: ServiceSectionId;
  label: string;
  path: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export const serviceNavigationItems: ServiceNavigationItem[] = [
  {
    id: 'runtime',
    label: 'Runtime',
    path: '/services/runtime',
    description: 'Xpod runtime, Solid server, AI Gateway, storage, and worker health.',
    icon: Activity,
  },
  {
    id: 'logs',
    label: 'Logs',
    path: '/services/logs',
    description: 'Runtime logs and sanitized diagnostics export.',
    icon: ScrollText,
  },
  {
    id: 'rdf',
    label: 'RDF',
    path: '/services/rdf',
    description: 'RDF indexing, storage stats, cache health, and slow query evidence.',
    icon: Database,
  },
  {
    id: 'configuration',
    label: 'Configuration',
    path: '/services/configuration',
    description: 'Advanced local runtime configuration and restart-controlled changes.',
    icon: Settings,
  },
];
