import { useLiveQuery } from '@tanstack/react-db';
import type { PodCollection } from './types.js';

/**
 * `./react` 入口（§6.2）：只有这里 import `@tanstack/react-db`，主入口保持无 React。
 *
 * P1 只保证这一层的签名与编译（§8.2 的测试清单里没有 React 用例）；真实渲染、
 * live query 与乐观层的交互验收在 P3 的 pilot 页面上做（§8.6）。
 */

export { useLiveQuery };
export type { PodCollection } from './types.js';

/**
 * 便捷 hook：把一个集合当单表读出来。
 * `rows` 已含乐观行（库的 `state` 语义），`status` 直接来自 live query。
 */
export function usePodCollection<R extends { id: string }>(collection: PodCollection<R>): {
  rows: R[];
  status: ReturnType<typeof useLiveQuery>['status'];
  isLoading: boolean;
} {
  const { data, status, isLoading } = useLiveQuery({
    query: (q) => q.from({ row: collection }),
  });
  return {
    rows: data as unknown as R[],
    status,
    isLoading,
  };
}
