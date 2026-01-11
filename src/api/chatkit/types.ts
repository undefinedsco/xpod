/**
 * ChatKit Types
 * 
 * Type definitions for OpenAI ChatKit protocol.
 * Based on https://github.com/openai/chatkit-python
 */

// ============================================================================
// Generic Types
// ============================================================================

export interface Page<T> {
  data: T[];
  has_more: boolean;
  after?: string;
}

// ============================================================================
// Thread Types
// ============================================================================

export type ThreadStatusType = 'active' | 'locked' | 'closed';

export interface ActiveStatus {
  type: 'active';
}

export interface LockedStatus {
  type: 'locked';
  reason?: string;
}

export interface ClosedStatus {
  type: 'closed';
}

export type ThreadStatus = ActiveStatus | LockedStatus | ClosedStatus;

export interface ThreadMetadata {
  id: string;
  title?: string;
  status: ThreadStatus;
  created_at: number;
  updated_at: number;
  metadata?: Record<string, unknown>;
}

export interface Thread extends ThreadMetadata {
  items: Page<ThreadItem>;
}

// ============================================================================
// Thread Item Types
// ============================================================================

export interface ThreadItemBase {
  id: string;
  thread_id: string;
  created_at: number;
}

// User Message
export interface UserMessageTextContent {
  type: 'input_text';
  text: string;
}

export interface UserMessageTagContent {
  type: 'input_tag';
  tag: string;
  label?: string;
}

export type UserMessageContent = UserMessageTextContent | UserMessageTagContent;

export interface InferenceOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: ToolChoice;
}

export interface ToolChoice {
  type: 'function';
  function: {
    name: string;
  };
}

export interface UserMessageItem extends ThreadItemBase {
  type: 'user_message';
  content: UserMessageContent[];
  inference_options?: InferenceOptions;
}

// Assistant Message
export interface Annotation {
  type: string;
  text: string;
  start_index?: number;
  end_index?: number;
  file_citation?: {
    file_id: string;
    quote?: string;
  };
  file_path?: {
    file_id: string;
  };
  url_citation?: {
    url: string;
    title?: string;
  };
}

export interface AssistantMessageContent {
  type: 'output_text';
  text: string;
  annotations?: Annotation[];
}

export interface AssistantMessageItem extends ThreadItemBase {
  type: 'assistant_message';
  content: AssistantMessageContent[];
  status?: 'in_progress' | 'completed' | 'incomplete';
}

// Client Tool Call
export interface ClientToolCallItem extends ThreadItemBase {
  type: 'client_tool_call';
  name: string;
  arguments: string;
  call_id: string;
  status?: 'pending' | 'completed';
  output?: string;
}

// Widget
export interface WidgetItem extends ThreadItemBase {
  type: 'widget';
  widget_type: string;
  data: unknown;
}

// Generated Image
export interface GeneratedImage {
  id: string;
  url?: string;
  b64_json?: string;
}

export interface GeneratedImageItem extends ThreadItemBase {
  type: 'generated_image';
  image: GeneratedImage;
  prompt?: string;
  status?: 'in_progress' | 'completed' | 'failed';
}

// Task
export interface BaseTask {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface CustomTask extends BaseTask {
  type: 'custom';
  title: string;
  description?: string;
}

export interface SearchTask extends BaseTask {
  type: 'web_search';
  query: string;
}

export interface ThoughtTask extends BaseTask {
  type: 'thought';
  content: string;
}

export interface FileTask extends BaseTask {
  type: 'file';
  file_id: string;
  filename?: string;
}

export interface ImageTask extends BaseTask {
  type: 'image';
  image_id: string;
}

export type Task = CustomTask | SearchTask | ThoughtTask | FileTask | ImageTask;

export interface TaskItem extends ThreadItemBase {
  type: 'task';
  task: Task;
}

// Workflow
export interface CustomSummary {
  type: 'custom';
  title: string;
  icon?: string;
}

export interface DurationSummary {
  type: 'duration';
  duration_ms: number;
}

export type WorkflowSummary = CustomSummary | DurationSummary;

export interface Workflow {
  tasks: Task[];
  summary?: WorkflowSummary;
}

export interface WorkflowItem extends ThreadItemBase {
  type: 'workflow';
  workflow: Workflow;
}

// End of Turn
export interface EndOfTurnItem extends ThreadItemBase {
  type: 'end_of_turn';
}

// Hidden Context
export interface HiddenContextItem extends ThreadItemBase {
  type: 'hidden_context_item';
  context: unknown;
}

export interface SDKHiddenContextItem extends ThreadItemBase {
  type: 'sdk_hidden_context';
  data: unknown;
}

// Union of all thread items
export type ThreadItem =
  | UserMessageItem
  | AssistantMessageItem
  | ClientToolCallItem
  | WidgetItem
  | GeneratedImageItem
  | TaskItem
  | WorkflowItem
  | EndOfTurnItem
  | HiddenContextItem
  | SDKHiddenContextItem;

export type StoreItemType = ThreadItem['type'];

// ============================================================================
// Attachment Types
// ============================================================================

export interface AttachmentBase {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  created_at: number;
}

export interface FileAttachment extends AttachmentBase {
  type: 'file';
  url?: string;
}

export interface ImageAttachment extends AttachmentBase {
  type: 'image';
  url?: string;
  width?: number;
  height?: number;
}

export type Attachment = FileAttachment | ImageAttachment;

export interface AttachmentUploadDescriptor {
  attachment_id: string;
  upload_url: string;
  upload_headers?: Record<string, string>;
}

// ============================================================================
// Request Types
// ============================================================================

export interface BaseReq {
  metadata?: Record<string, unknown>;
}

// Thread Requests
export interface ThreadGetByIdParams {
  thread_id: string;
}

export interface ThreadsGetByIdReq extends BaseReq {
  type: 'threads.get_by_id';
  params: ThreadGetByIdParams;
}

export interface ThreadCreateParams {
  input?: UserMessageInput;
}

export interface UserMessageInput {
  content: UserMessageContent[];
  inference_options?: InferenceOptions;
  attachments?: string[];
}

export interface ThreadsCreateReq extends BaseReq {
  type: 'threads.create';
  params: ThreadCreateParams;
}

export interface ThreadListParams {
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
}

export interface ThreadsListReq extends BaseReq {
  type: 'threads.list';
  params: ThreadListParams;
}

export interface ThreadAddUserMessageParams {
  thread_id: string;
  input: UserMessageInput;
}

export interface ThreadsAddUserMessageReq extends BaseReq {
  type: 'threads.add_user_message';
  params: ThreadAddUserMessageParams;
}

export interface ThreadAddClientToolOutputParams {
  thread_id: string;
  item_id: string;
  output: string;
}

export interface ThreadsAddClientToolOutputReq extends BaseReq {
  type: 'threads.add_client_tool_output';
  params: ThreadAddClientToolOutputParams;
}

export interface ThreadCustomActionParams {
  thread_id: string;
  item_id: string;
  action: string;
  data?: unknown;
}

export interface ThreadsCustomActionReq extends BaseReq {
  type: 'threads.custom_action';
  params: ThreadCustomActionParams;
}

export interface ThreadRetryAfterItemParams {
  thread_id: string;
  item_id: string;
}

export interface ThreadsRetryAfterItemReq extends BaseReq {
  type: 'threads.retry_after_item';
  params: ThreadRetryAfterItemParams;
}

export interface ThreadUpdateParams {
  thread_id: string;
  title?: string;
}

export interface ThreadsUpdateReq extends BaseReq {
  type: 'threads.update';
  params: ThreadUpdateParams;
}

export interface ThreadDeleteParams {
  thread_id: string;
}

export interface ThreadsDeleteReq extends BaseReq {
  type: 'threads.delete';
  params: ThreadDeleteParams;
}

// Items Requests
export interface ItemsListParams {
  thread_id: string;
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
}

export interface ItemsListReq extends BaseReq {
  type: 'items.list';
  params: ItemsListParams;
}

export interface ItemFeedbackParams {
  thread_id: string;
  item_ids: string[];
  feedback: FeedbackKind;
}

export type FeedbackKind = 'positive' | 'negative';

export interface ItemsFeedbackReq extends BaseReq {
  type: 'items.feedback';
  params: ItemFeedbackParams;
}

// Attachment Requests
export interface AttachmentCreateParams {
  name: string;
  size: number;
  mime_type: string;
}

export interface AttachmentsCreateReq extends BaseReq {
  type: 'attachments.create';
  params: AttachmentCreateParams;
}

export interface AttachmentDeleteParams {
  attachment_id: string;
}

export interface AttachmentsDeleteReq extends BaseReq {
  type: 'attachments.delete';
  params: AttachmentDeleteParams;
}

// Request Union Types
export type StreamingReq =
  | ThreadsCreateReq
  | ThreadsAddUserMessageReq
  | ThreadsAddClientToolOutputReq
  | ThreadsRetryAfterItemReq
  | ThreadsCustomActionReq;

export type NonStreamingReq =
  | ThreadsGetByIdReq
  | ThreadsListReq
  | ItemsListReq
  | ItemsFeedbackReq
  | AttachmentsCreateReq
  | AttachmentsDeleteReq
  | ThreadsUpdateReq
  | ThreadsDeleteReq;

export type ChatKitReq = StreamingReq | NonStreamingReq;

// ============================================================================
// Stream Event Types
// ============================================================================

export interface ThreadCreatedEvent {
  type: 'thread.created';
  thread: ThreadMetadata;
}

export interface ThreadUpdatedEvent {
  type: 'thread.updated';
  thread: ThreadMetadata;
}

export interface ThreadItemAddedEvent {
  type: 'thread.item.added';
  item: ThreadItem;
}

export interface ThreadItemUpdatedEvent {
  type: 'thread.item.updated';
  item_id: string;
  update: ThreadItemUpdate;
}

export interface ThreadItemDoneEvent {
  type: 'thread.item.done';
  item: ThreadItem;
}

export interface ThreadItemRemovedEvent {
  type: 'thread.item.removed';
  item_id: string;
}

export interface ThreadItemReplacedEvent {
  type: 'thread.item.replaced';
  item: ThreadItem;
}

export interface StreamOptions {
  allow_cancel?: boolean;
}

export interface StreamOptionsEvent {
  type: 'stream_options';
  options: StreamOptions;
}

export interface ProgressUpdate {
  progress: number;
  message?: string;
}

export interface ProgressUpdateEvent {
  type: 'progress_update';
  update: ProgressUpdate;
}

export interface ClientEffect {
  effect_type: string;
  data?: unknown;
}

export interface ClientEffectEvent {
  type: 'client_effect';
  effect: ClientEffect;
}

export interface ErrorEvent {
  type: 'error';
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface NoticeEvent {
  type: 'notice';
  notice: {
    level: 'info' | 'warning' | 'error';
    message: string;
  };
}

export type ThreadStreamEvent =
  | ThreadCreatedEvent
  | ThreadUpdatedEvent
  | ThreadItemAddedEvent
  | ThreadItemUpdatedEvent
  | ThreadItemDoneEvent
  | ThreadItemRemovedEvent
  | ThreadItemReplacedEvent
  | StreamOptionsEvent
  | ProgressUpdateEvent
  | ClientEffectEvent
  | ErrorEvent
  | NoticeEvent;

// ============================================================================
// Thread Item Update Types (for streaming)
// ============================================================================

export interface AssistantMessageContentPartAdded {
  type: 'assistant_message.content_part.added';
  part_index: number;
  part: AssistantMessageContent;
}

export interface AssistantMessageContentPartTextDelta {
  type: 'assistant_message.content_part.text_delta';
  part_index: number;
  delta: string;
}

export interface AssistantMessageContentPartAnnotationAdded {
  type: 'assistant_message.content_part.annotation_added';
  part_index: number;
  annotation: Annotation;
}

export interface AssistantMessageContentPartDone {
  type: 'assistant_message.content_part.done';
  part_index: number;
}

export interface WidgetStreamingTextValueDelta {
  type: 'widget.streaming_text.value_delta';
  path: string;
  delta: string;
}

export interface WidgetRootUpdated {
  type: 'widget.root.updated';
  data: unknown;
}

export interface WidgetComponentUpdated {
  type: 'widget.component.updated';
  component_id: string;
  data: unknown;
}

export interface WorkflowTaskAdded {
  type: 'workflow.task.added';
  task: Task;
}

export interface WorkflowTaskUpdated {
  type: 'workflow.task.updated';
  task_id: string;
  task: Partial<Task>;
}

export interface GeneratedImageUpdated {
  type: 'generated_image.updated';
  image: GeneratedImage;
}

export type ThreadItemUpdate =
  | AssistantMessageContentPartAdded
  | AssistantMessageContentPartTextDelta
  | AssistantMessageContentPartAnnotationAdded
  | AssistantMessageContentPartDone
  | WidgetStreamingTextValueDelta
  | WidgetRootUpdated
  | WidgetComponentUpdated
  | WorkflowTaskAdded
  | WorkflowTaskUpdated
  | GeneratedImageUpdated;

// ============================================================================
// Response Types
// ============================================================================

export interface StreamingResult {
  type: 'streaming';
  stream: AsyncIterable<ThreadStreamEvent>;
}

export interface NonStreamingResult {
  type: 'non_streaming';
  data: unknown;
}

export type ChatKitResult = StreamingResult | NonStreamingResult;

// ============================================================================
// Helper Functions
// ============================================================================

export function isStreamingReq(req: ChatKitReq): req is StreamingReq {
  return (
    req.type === 'threads.create' ||
    req.type === 'threads.add_user_message' ||
    req.type === 'threads.add_client_tool_output' ||
    req.type === 'threads.retry_after_item' ||
    req.type === 'threads.custom_action'
  );
}

export function isNonStreamingReq(req: ChatKitReq): req is NonStreamingReq {
  return !isStreamingReq(req);
}

/**
 * Generate a unique ID with prefix
 */
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Get current timestamp in seconds
 */
export function nowTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Extract text content from user message
 */
export function extractUserMessageText(content: UserMessageContent[]): string {
  return content
    .filter((c): c is UserMessageTextContent => c.type === 'input_text')
    .map((c) => c.text)
    .join('\n');
}
