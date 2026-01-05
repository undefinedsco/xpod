/**
 * Credential Schema 类型定义
 */

/**
 * 服务类型
 */
export enum ServiceType {
  AI = 'ai',
  STORAGE = 'storage',
  DNS = 'dns',
}

/**
 * 凭据状态
 */
export enum CredentialStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  RATE_LIMITED = 'rate_limited',
  EXPIRED = 'expired',
}
