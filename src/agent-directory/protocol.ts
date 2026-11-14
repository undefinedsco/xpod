// Transitional public adapter; contracts remain canonical in the AFS package.
import { AGENT_DIRECTORY_SIDECAR as sidecar } from '@undefineds.co/xpod-afs/directory/protocol';
export const AGENT_DIRECTORY_SIDECAR = sidecar;
export type AgentDirectoryOperation = import('@undefineds.co/xpod-afs/directory/protocol').AgentDirectoryOperation;
export type AgentDirectoryListQuery = import('@undefineds.co/xpod-afs/directory/protocol').AgentDirectoryListQuery;
export type AgentDirectoryEntry = import('@undefineds.co/xpod-afs/directory/protocol').AgentDirectoryEntry;
export type AgentDirectoryListResponse = import('@undefineds.co/xpod-afs/directory/protocol').AgentDirectoryListResponse;
export type AgentDirectorySearchQuery = import('@undefineds.co/xpod-afs/directory/protocol').AgentDirectorySearchQuery;
export type AgentDirectorySearchMatch = import('@undefineds.co/xpod-afs/directory/protocol').AgentDirectorySearchMatch;
export type AgentDirectorySearchResponse = import('@undefineds.co/xpod-afs/directory/protocol').AgentDirectorySearchResponse;
export type AgentDirectoryReadResponse = import('@undefineds.co/xpod-afs/directory/protocol').AgentDirectoryReadResponse;
export type AgentDirectoryErrorResponse = import('@undefineds.co/xpod-afs/directory/protocol').AgentDirectoryErrorResponse;
