/**
 * ObservableResourceStore - 可观察的资源存储包装器
 *
 * 在资源变更时发出事件，供订阅者（如 UsageTracker、VectorIndexer）处理。
 * 采用事件驱动模式，解耦存储操作与副作用逻辑。
 */

import { EventEmitter } from 'node:events';
import { PassthroughStore } from '@solid/community-server';
import type {
  ChangeMap,
  Representation,
  RepresentationPreferences,
  ResourceIdentifier,
  Conditions,
  ResourceStore,
} from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';

/**
 * 资源变更事件类型
 */
export type ResourceChangeAction = 'create' | 'update' | 'delete';

/**
 * 资源变更事件
 */
export interface ResourceChangeEvent {
  /** 资源路径 */
  path: string;
  /** 变更类型 */
  action: ResourceChangeAction;
  /** 是否为容器 */
  isContainer: boolean;
  /** 变更时间戳 */
  timestamp: number;
}

/**
 * 资源变更监听器接口
 */
export interface ResourceChangeListener {
  /**
   * 处理资源变更事件
   * @param event 变更事件
   */
  onResourceChanged(event: ResourceChangeEvent): Promise<void>;
}

export interface ObservableResourceStoreOptions {
  /** 资源变更监听器列表 */
  listeners?: ResourceChangeListener[];
}

/**
 * ObservableResourceStore - 在资源变更时发出事件
 *
 * 使用方式：
 * 1. 作为 Store 链的包装层
 * 2. 注册 listeners 处理变更事件
 * 3. 事件异步处理，不阻塞主流程
 */
export class ObservableResourceStore<T extends ResourceStore = ResourceStore> extends PassthroughStore<T> {
  protected readonly logger = getLoggerFor(this);
  private readonly emitter = new EventEmitter();
  private readonly listeners: ResourceChangeListener[];

  public constructor(source: T, options: ObservableResourceStoreOptions = {}) {
    super(source);
    this.listeners = options.listeners ?? [];

    // 注册内部事件处理
    this.emitter.on('resource:changed', (event: ResourceChangeEvent) => {
      this.notifyListeners(event);
    });
  }

  /**
   * 添加监听器
   */
  public addListener(listener: ResourceChangeListener): void {
    this.listeners.push(listener);
  }

  /**
   * 移除监听器
   */
  public removeListener(listener: ResourceChangeListener): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * 添加资源（创建新资源）
   */
  public override async addResource(
    container: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    const change = await super.addResource(container, representation, conditions);

    // 从 ChangeMap 中获取新创建的资源路径
    for (const [identifier] of change) {
      this.emitChange(identifier.path, 'create');
    }

    return change;
  }

  /**
   * 设置资源（创建或更新）
   */
  public override async setRepresentation(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    // 检查资源是否已存在
    const exists = await this.resourceExists(identifier);
    const action: ResourceChangeAction = exists ? 'update' : 'create';

    const change = await super.setRepresentation(identifier, representation, conditions);

    this.emitChange(identifier.path, action);

    return change;
  }

  /**
   * 删除资源
   */
  public override async deleteResource(
    identifier: ResourceIdentifier,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    const change = await super.deleteResource(identifier, conditions);

    this.emitChange(identifier.path, 'delete');

    return change;
  }

  /**
   * 修改资源（PATCH）
   */
  public override async modifyResource(
    identifier: ResourceIdentifier,
    patch: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    const change = await super.modifyResource(identifier, patch, conditions);

    this.emitChange(identifier.path, 'update');

    return change;
  }

  /**
   * 发出资源变更事件
   */
  private emitChange(path: string, action: ResourceChangeAction): void {
    const event: ResourceChangeEvent = {
      path,
      action,
      isContainer: path.endsWith('/'),
      timestamp: Date.now(),
    };

    this.logger.debug(`Resource ${action}: ${path}`);

    // 异步发出事件，不阻塞主流程
    setImmediate(() => {
      this.emitter.emit('resource:changed', event);
    });
  }

  /**
   * 通知所有监听器
   */
  private notifyListeners(event: ResourceChangeEvent): void {
    for (const listener of this.listeners) {
      listener.onResourceChanged(event).catch((error) => {
        this.logger.error(`Listener error for ${event.path}: ${error}`);
      });
    }
  }

  /**
   * 检查资源是否存在
   */
  private async resourceExists(identifier: ResourceIdentifier): Promise<boolean> {
    try {
      await this.source.getRepresentation(identifier, {} as RepresentationPreferences);
      return true;
    } catch {
      return false;
    }
  }
}
