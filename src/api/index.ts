/**
 * API Service - Standalone HTTP server for management APIs
 *
 * Separated from CSS main process for stability and security isolation.
 * Supports multiple authentication methods:
 * - Solid Token (DPoP) - for frontend users
 * - Client Credentials (API Key) - for third-party apps and internal services
 */

export * from './auth';
export * from './middleware';
export * from './store';
export * from './handlers';
export * from './ApiServer';
