import { Activity, Cable, Globe2, LockKeyhole, Network, Radio, Route, Waypoints } from 'lucide-react';
import type { ComponentType } from 'react';

export interface NetworkNavigationItem {
  id: string;
  label: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
}

export const networkNavigationItems: NetworkNavigationItem[] = [
  { id: 'overview', label: 'Overview', path: '', icon: Network },
  { id: 'endpoints', label: 'Endpoints', path: 'endpoints', icon: Cable },
  { id: 'addresses', label: 'Addresses', path: 'addresses', icon: Globe2 },
  { id: 'domain-dns', label: 'Domain & DNS', path: 'domain-dns', icon: Route },
  { id: 'https', label: 'HTTPS', path: 'https', icon: LockKeyhole },
  { id: 'tunnel-profiles', label: 'Tunnel Profiles', path: 'tunnel-profiles', icon: Waypoints },
  { id: 'p2p', label: 'P2P', path: 'p2p', icon: Radio },
  { id: 'diagnostics', label: 'Diagnostics', path: 'diagnostics', icon: Activity },
];
