import {
  ChatStatus,
  MessageRole,
  MessageStatus,
  chatResource,
  messageResource,
  threadResource,
  type ChatRow,
  type ChatStatusType,
  type MessageRoleType,
  type MessageRow,
  type MessageStatusType,
  type ThreadRow,
  type ThreadStatusType,
} from '@undefineds.co/models';

/**
 * ChatKit adapter schema exports.
 *
 * ChatKit is a protocol/adaptation layer in xpod. Durable Pod resources are
 * owned by @undefineds.co/models; this file only preserves local import names.
 */
export const Chat = chatResource;
export const Thread = threadResource;
export const Message = messageResource;

export { ChatStatus, MessageRole, MessageStatus };

export type ChatRecord = ChatRow;
export type ThreadRecord = ThreadRow;
export type MessageRecord = MessageRow;
export type {
  ChatStatusType,
  MessageRoleType,
  MessageStatusType,
  ThreadStatusType,
};
