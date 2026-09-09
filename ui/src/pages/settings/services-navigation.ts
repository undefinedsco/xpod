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
    label: '运行时',
    path: '/services/runtime',
    description: 'Xpod 运行时、Solid server、AI Gateway、存储与 worker 健康。',
    icon: Activity,
  },
  {
    id: 'logs',
    label: '日志',
    path: '/services/logs',
    description: '运行时日志与脱敏诊断信息导出。',
    icon: ScrollText,
  },
  {
    id: 'rdf',
    label: 'RDF',
    path: '/services/rdf',
    description: 'RDF 索引、存储统计、缓存健康与慢查询证据。',
    icon: Database,
  },
  {
    id: 'configuration',
    label: '配置',
    path: '/services/configuration',
    description: '高级本地运行时配置与受重启控制的变更。',
    icon: Settings,
  },
];
