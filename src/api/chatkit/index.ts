/**
 * ChatKit Module
 * 
 * OpenAI ChatKit protocol implementation for xpod-api-server.
 */

// Types
export * from './types';

// Schema (SolidOS compatible) - 使用别名避免与 types 冲突
export {
  ChatThread,
  ChatMessage,
  ThreadStatus as PodThreadStatus,
  MessageRole,
  MessageStatus,
  type ChatThreadRecord,
  type ChatMessageRecord,
  type ThreadStatusType as PodThreadStatusType,
  type MessageRoleType,
  type MessageStatusType,
  getThreadPath,
  getThreadSubject,
  getMessageSubject,
} from './schema';

// Store
export { type ChatKitStore, type StoreContext, InMemoryStore } from './store';
export { PodChatKitStore, type PodChatKitStoreOptions } from './pod-store';

// Service
export { ChatKitService, type AiProvider, type ChatKitServiceOptions, type StreamingResult, type NonStreamingResult, type ChatKitResult } from './service';

// AI Provider
export { VercelAiProvider, type VercelAiProviderOptions } from './ai-provider';
