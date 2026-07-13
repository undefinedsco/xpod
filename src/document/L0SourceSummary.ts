import { DEFAULT_DOCUMENT_READER_POLICY } from './ReaderPolicy';
import type { ReaderExpectedUse } from './ReaderPolicy';

export type SourceUsageSurface = 'chat' | 'task' | 'run' | 'message' | 'tool-call' | 'upload' | 'ui-open';
export type SourceUsageConfidence = 'low' | 'medium' | 'high';
export type L0SourceSummaryMode = 'context-inferred' | 'lightweight-preview' | 'old-cache';
export type L0SourceEvidence =
  | 'path'
  | 'mime'
  | 'message-context'
  | 'tool-history'
  | 'user-description'
  | 'neighbor-files'
  | 'old-cache'
  | 'local-preview';

export interface SourceUsageMention {
  surface: SourceUsageSurface;
  resource: string;
  title?: string;
  excerpt?: string;
  mentionedAs?: string;
  actor?: string;
  timestamp: string;
  confidence: SourceUsageConfidence;
}

export interface SourceRecentAction {
  action: 'uploaded' | 'opened' | 'edited' | 'moved' | 'renamed' | 'attached' | 'referenced' | 'generated';
  resource: string;
  timestamp: string;
  actor?: string;
}

export interface RelatedSource {
  source: string;
  relation: 'same-folder' | 'linked-from-message' | 'generated-from' | 'attached-together' | 'referenced-by-same-run';
}


export interface SourceUsageRecord {
  surface: SourceUsageSurface;
  resource: string;
  text?: string;
  title?: string;
  actor?: string;
  timestamp: string;
  action?: SourceRecentAction['action'];
  attachment?: {
    name?: string;
    url?: string;
    id?: string;
  };
}

export interface BuildSourceUsageContextInput {
  source: string;
  records: SourceUsageRecord[];
  maxExcerptLength?: number;
}

export interface SourceUsageContext {
  source: string;
  mentions: SourceUsageMention[];
  recentActions: SourceRecentAction[];
  relatedSources?: RelatedSource[];
}

export type L0GenerationAction = 'create-l0' | 'reader-required' | 'skip';

export interface L0SourceSummaryPlan {
  action: L0GenerationAction;
  mode?: L0SourceSummaryMode;
  evidence: L0SourceEvidence[];
  confidence: SourceUsageConfidence;
  previewSuggestion?: {
    pages?: string;
    bytes?: number;
    lines?: string;
  };
  reason: string;
}

export interface L0SourceSummaryInput {
  source: string;
  sourceUsageContext: SourceUsageContext;
  requestedEvidence?: ReaderExpectedUse;
  oldCacheFresh?: boolean;
  lightweightPreviewAvailable?: boolean;
  pathHint?: string;
}

export interface L0SourceSummary {
  source: string;
  summary?: string;
  mode: L0SourceSummaryMode;
  confidence: SourceUsageConfidence;
  evidence: L0SourceEvidence[];
  previewRange?: {
    pages?: string;
    bytes?: number;
    lines?: string;
  };
  readerConfirmed: false;
  sourceUsageContext?: SourceUsageContext;
}

export interface CreateL0SourceSummaryInput {
  source: string;
  summary?: string;
  mode: L0SourceSummaryMode;
  confidence: SourceUsageConfidence;
  evidence: L0SourceEvidence[];
  previewRange?: {
    pages?: string;
    bytes?: number;
    lines?: string;
  };
  sourceUsageContext?: SourceUsageContext;
  maxExcerptLength?: number;
}

const READER_REQUIRED_USES = new Set<ReaderExpectedUse>(['table-extraction', 'ocr', 'full-import']);

export function chooseL0SourceSummaryPlan(input: L0SourceSummaryInput): L0SourceSummaryPlan {
  if (input.requestedEvidence && READER_REQUIRED_USES.has(input.requestedEvidence)) {
    return {
      action: 'reader-required',
      evidence: [],
      confidence: 'low',
      reason: `Requested evidence ${input.requestedEvidence} needs reader output beyond L0.`,
    };
  }

  if (input.oldCacheFresh) {
    return {
      action: 'create-l0',
      mode: 'old-cache',
      evidence: ['old-cache'],
      confidence: 'high',
      reason: 'Fresh old cache can be reused for source-level summary.',
    };
  }

  const highContext = input.sourceUsageContext.mentions.some((mention) => mention.confidence === 'high');
  const meaningfulPath = hasMeaningfulPath(input.pathHint ?? input.source);
  if (highContext || meaningfulPath) {
    const evidence: L0SourceEvidence[] = [];
    if (meaningfulPath) evidence.push('path');
    if (highContext) evidence.push('message-context');
    return {
      action: 'create-l0',
      mode: 'context-inferred',
      evidence,
      confidence: highContext ? 'high' : 'medium',
      reason: 'Path or product context is enough to infer an L0 source summary.',
    };
  }

  if (input.lightweightPreviewAvailable) {
    return {
      action: 'create-l0',
      mode: 'lightweight-preview',
      evidence: ['local-preview'],
      confidence: 'medium',
      previewSuggestion: {
        pages: String(DEFAULT_DOCUMENT_READER_POLICY.l0.suggestion.localPreviewPages),
        bytes: DEFAULT_DOCUMENT_READER_POLICY.l0.suggestion.localPreviewBytes,
      },
      reason: 'Context is weak; read lightweight preview before writing L0.',
    };
  }

  return {
    action: 'skip',
    evidence: [],
    confidence: 'low',
    reason: 'No reliable context or preview is available for L0.',
  };
}

export function createL0SourceSummary(input: CreateL0SourceSummaryInput): L0SourceSummary {
  return {
    source: input.source,
    summary: input.summary,
    mode: input.mode,
    confidence: input.confidence,
    evidence: [...new Set(input.evidence)],
    previewRange: input.previewRange,
    readerConfirmed: false,
    sourceUsageContext: input.sourceUsageContext
      ? boundSourceUsageContext(input.sourceUsageContext, input.maxExcerptLength ?? 240)
      : undefined,
  };
}

export function boundSourceUsageContext(context: SourceUsageContext, maxExcerptLength = 240): SourceUsageContext {
  return {
    ...context,
    mentions: context.mentions.map((mention) => ({
      ...mention,
      excerpt: mention.excerpt ? truncate(mention.excerpt, maxExcerptLength) : undefined,
    })),
    recentActions: [...context.recentActions],
    relatedSources: context.relatedSources ? [...context.relatedSources] : undefined,
  };
}


export function buildSourceUsageContext(input: BuildSourceUsageContextInput): SourceUsageContext {
  const sourceName = sourceBasename(input.source);
  const maxExcerptLength = input.maxExcerptLength ?? 240;
  const mentions: SourceUsageMention[] = [];
  const recentActions: SourceRecentAction[] = [];

  for (const record of input.records) {
    const matchedAttachment = attachmentMatchesSource(record.attachment, input.source, sourceName);
    const matchedText = textMentionsSource(record.text, input.source, sourceName);

    if (matchedAttachment || matchedText) {
      const excerptSource = record.text ?? record.title ?? record.attachment?.name ?? sourceName;
      mentions.push({
        surface: record.surface,
        resource: record.resource,
        title: record.title,
        excerpt: truncate(excerptSource, maxExcerptLength),
        mentionedAs: matchedAttachment ? (record.attachment?.name ?? sourceName) : sourceName,
        actor: record.actor,
        timestamp: record.timestamp,
        confidence: matchedAttachment ? 'high' : 'medium',
      });
    }

    if (record.action && (matchedAttachment || matchedText)) {
      recentActions.push({
        action: record.action,
        resource: record.resource,
        timestamp: record.timestamp,
        actor: record.actor,
      });
    }
  }

  return {
    source: input.source,
    mentions,
    recentActions,
  };
}

function attachmentMatchesSource(
  attachment: SourceUsageRecord['attachment'] | undefined,
  source: string,
  sourceName: string,
): boolean {
  if (!attachment) return false;
  return attachment.url === source || attachment.id === source || attachment.name === sourceName;
}

function textMentionsSource(text: string | undefined, source: string, sourceName: string): boolean {
  if (!text) return false;
  return text.includes(source) || text.includes(sourceName);
}

function sourceBasename(source: string): string {
  try {
    const parsed = new URL(source);
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? source);
  } catch {
    return source.split(/[\/]/u).filter(Boolean).pop() ?? source;
  }
}

function hasMeaningfulPath(path: string): boolean {
  const tail = path.split(/[/?#]/u).filter(Boolean).pop() ?? path;
  const base = tail.replace(/\.[a-z0-9]+$/iu, '').toLowerCase();
  if (!base || base.length < 4) return false;
  if (/^(scan|image|img|doc|file|untitled|new|tmp|temp)[-_ ]?\d*$/iu.test(base)) return false;
  return /[a-z\u4e00-\u9fff]{3,}/iu.test(base);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 1)) + '…';
}
