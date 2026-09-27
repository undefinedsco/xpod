import { Gauge, Globe, Layers, Sparkles } from 'lucide-react';
import type { ComponentType } from 'react';

/**
 * 顶层导航按用户任务组织，不按内部模块名：概览、存储空间、AI、服务与访问；身份入口由用户卡
 * 单独承担（`XpodUserCard`），不再作为一个工作区入口。
 *
 * 依据 docs/superpowers/specs/2026-09-27-xpod-product-experience-spec.md §3.1（四入口与
 * `section` 枚举）、§3.3（历史入口映射）与 AC-04。`activePaths` 只放规范路径：旧路径先经
 * `canonicalProductPathname` 重定向，避免用 `/status`、`/settings` 这类前缀让两个入口同时命中。
 */
export type GlobalNavigationItemId = 'overview' | 'storage' | 'ai' | 'services';

export interface GlobalNavigationItem {
  id: GlobalNavigationItemId;
  /** 顶层中文名（§2）。 */
  label: string;
  /** 顶层英文名（§2），供 aria 与以后的语言层使用。 */
  labelEn: string;
  href: string;
  activePaths: readonly string[];
  icon: ComponentType<{ className?: string }>;
}

export const globalNavigationItems = [
  {
    id: 'overview',
    label: '概览',
    labelEn: 'Overview',
    href: '/status/overview',
    activePaths: ['/status/overview'],
    icon: Gauge,
  },
  {
    id: 'storage',
    label: '存储空间',
    labelEn: 'Storage Spaces',
    href: '/settings/pod',
    // §3.1：空间内的搜索索引与维护任务留在存储空间上下文
    activePaths: ['/settings/pod', '/ai-config/search-indexing', '/ai-config/index-lifecycle'],
    icon: Layers,
  },
  {
    id: 'ai',
    label: 'AI',
    labelEn: 'AI',
    href: '/ai-connections',
    // §3.1：用途模型与资料处理属于 AI 上下文
    activePaths: ['/ai-connections', '/ai-config/model-assignments', '/ai-config/document-processing'],
    icon: Sparkles,
  },
  {
    id: 'services',
    label: '服务与访问',
    labelEn: 'Services & Access',
    href: '/settings/runtime',
    // §3.1：服务、连接与诊断同属一个任务域，专业深链由前缀覆盖
    activePaths: [
      '/settings/runtime',
      '/network',
      '/status/logs',
      '/status/services',
      '/status/index',
      '/status/usage',
    ],
    icon: Globe,
  },
] as const satisfies readonly GlobalNavigationItem[];

export function isGlobalNavigationItemActive(item: GlobalNavigationItem, pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return item.activePaths.some((path) => normalized === path || normalized.startsWith(`${path}/`));
}
