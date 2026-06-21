export type ReaderDecisionOwner = 'agent' | 'system-prefetch' | 'user';

export type ReaderExpectedUse =
  | 'structure-probe'
  | 'answer-evidence'
  | 'table-extraction'
  | 'ocr'
  | 'full-import';

export type SystemPrefetchTrigger =
  | 'user-open-detail'
  | 'user-scroll-near-unread-page'
  | 'user-search-within-document';

export interface DocumentReaderPolicy {
  provider: string;
  model: string;
  l0: {
    readExternal: false;
    decisionOwner: 'agent';
    allowContextInference: boolean;
    allowLightweightPreview: boolean;
    suggestion: {
      localPreviewPages: number;
      localPreviewBytes: number;
    };
  };
  decision: {
    owner: 'agent';
    defaultSuggestion: {
      initialPages: number;
      structureProbeMaxPages: number;
      pageWindow: number;
      maxPageWindow: number;
    };
    allowAgentOverride: boolean;
    requireReason: boolean;
    exposeBudgetToAgent: boolean;
    overBudgetBehavior: 'ask-user-or-degrade';
  };
  systemPrefetch: {
    owner: 'system';
    triggers: SystemPrefetchTrigger[];
    lookAheadPages: number;
    maxLookAheadPages: number;
    respectHardLimits: boolean;
  };
  hardLimits: {
    maxPagesPerRun: number;
    maxPagesPerFilePerDay: number;
    maxDailyProviderBudgetRatio: number;
  };
}

export interface ReaderUsageSnapshot {
  runUsedPages: number;
  fileUsedPagesToday: number;
  providerUsedPagesToday: number;
  providerDailyPages?: number;
}

export interface ReaderBudgetSnapshot {
  runRemainingPages: number;
  fileRemainingPagesToday: number;
  providerRemainingPagesToday?: number;
  providerSoftBudgetPagesToday?: number;
  providerSoftRemainingPagesToday?: number;
}

export interface ReaderRequest {
  owner: ReaderDecisionOwner;
  source: string;
  pageRange: string;
  reason?: string;
  expectedUse?: ReaderExpectedUse;
  userConfirmed?: boolean;
  trigger?: SystemPrefetchTrigger;
  lookAheadPages?: number;
}

export interface ReaderRequestEvaluation {
  status: 'allow' | 'needs_user_confirmation' | 'deny';
  pageCount: number;
  budget: ReaderBudgetSnapshot;
  reasons: string[];
}

export interface SystemPrefetchInput {
  source: string;
  trigger: SystemPrefetchTrigger;
  visiblePage: number;
  totalPages?: number;
  readRanges?: string[];
}

export interface SystemPrefetchRequest extends ReaderRequest {
  owner: 'system-prefetch';
  trigger: SystemPrefetchTrigger;
  visiblePage: number;
  lookAheadPages: number;
}

export const DEFAULT_DOCUMENT_READER_POLICY: DocumentReaderPolicy = {
  provider: 'paddleocr',
  model: 'pp-ocrv6',
  l0: {
    readExternal: false,
    decisionOwner: 'agent',
    allowContextInference: true,
    allowLightweightPreview: true,
    suggestion: {
      localPreviewPages: 1,
      localPreviewBytes: 65_536,
    },
  },
  decision: {
    owner: 'agent',
    defaultSuggestion: {
      initialPages: 20,
      structureProbeMaxPages: 50,
      pageWindow: 50,
      maxPageWindow: 100,
    },
    allowAgentOverride: true,
    requireReason: true,
    exposeBudgetToAgent: true,
    overBudgetBehavior: 'ask-user-or-degrade',
  },
  systemPrefetch: {
    owner: 'system',
    triggers: ['user-open-detail', 'user-scroll-near-unread-page', 'user-search-within-document'],
    lookAheadPages: 10,
    maxLookAheadPages: 30,
    respectHardLimits: true,
  },
  hardLimits: {
    maxPagesPerRun: 500,
    maxPagesPerFilePerDay: 1_000,
    maxDailyProviderBudgetRatio: 0.8,
  },
};

export function countPagesInRange(pageRange: string): number {
  const ranges = pageRange
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (ranges.length === 0) return 0;

  let total = 0;
  for (const range of ranges) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(range);
    if (!match) return 0;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return 0;
    }
    total += end - start + 1;
  }
  return total;
}

export function computeReaderBudget(policy: DocumentReaderPolicy, usage: ReaderUsageSnapshot): ReaderBudgetSnapshot {
  const providerRemainingPagesToday = usage.providerDailyPages === undefined
    ? undefined
    : Math.max(0, usage.providerDailyPages - usage.providerUsedPagesToday);
  const providerSoftBudgetPagesToday = usage.providerDailyPages === undefined
    ? undefined
    : Math.floor(usage.providerDailyPages * policy.hardLimits.maxDailyProviderBudgetRatio);
  const providerSoftRemainingPagesToday = providerSoftBudgetPagesToday === undefined
    ? undefined
    : Math.max(0, providerSoftBudgetPagesToday - usage.providerUsedPagesToday);

  return {
    runRemainingPages: Math.max(0, policy.hardLimits.maxPagesPerRun - usage.runUsedPages),
    fileRemainingPagesToday: Math.max(0, policy.hardLimits.maxPagesPerFilePerDay - usage.fileUsedPagesToday),
    providerRemainingPagesToday,
    providerSoftBudgetPagesToday,
    providerSoftRemainingPagesToday,
  };
}

export function evaluateReaderRequest(
  policy: DocumentReaderPolicy,
  request: ReaderRequest,
  usage: ReaderUsageSnapshot,
): ReaderRequestEvaluation {
  const pageCount = countPagesInRange(request.pageRange);
  const budget = computeReaderBudget(policy, usage);
  const reasons: string[] = [];

  if (pageCount <= 0) reasons.push('invalid_page_range');
  if (request.owner === 'agent' && policy.decision.requireReason && !request.reason?.trim()) {
    reasons.push('agent_reason_required');
  }
  if (pageCount > budget.runRemainingPages) reasons.push('run_page_limit_exceeded');
  if (pageCount > budget.fileRemainingPagesToday) reasons.push('file_daily_page_limit_exceeded');
  if (budget.providerRemainingPagesToday !== undefined && pageCount > budget.providerRemainingPagesToday) {
    reasons.push('provider_daily_pages_exhausted');
  }

  const hardFailure = reasons.some((reason) => reason !== 'provider_soft_budget_exceeded');
  if (hardFailure) {
    return { status: 'deny', pageCount, budget, reasons };
  }

  if (
    request.owner !== 'user'
    && !request.userConfirmed
    && budget.providerSoftRemainingPagesToday !== undefined
    && pageCount > budget.providerSoftRemainingPagesToday
  ) {
    return {
      status: 'needs_user_confirmation',
      pageCount,
      budget,
      reasons: ['provider_soft_budget_exceeded'],
    };
  }

  return { status: 'allow', pageCount, budget, reasons };
}

export function planSystemPrefetch(
  policy: DocumentReaderPolicy,
  input: SystemPrefetchInput,
): SystemPrefetchRequest | undefined {
  if (!policy.systemPrefetch.triggers.includes(input.trigger)) return undefined;

  const visiblePage = Math.max(1, Math.floor(input.visiblePage));
  const lookAheadPages = policy.systemPrefetch.lookAheadPages;
  const maxEnd = input.totalPages === undefined
    ? visiblePage + lookAheadPages
    : Math.min(input.totalPages, visiblePage + lookAheadPages);

  const firstUnread = firstUnreadPage(visiblePage, maxEnd, input.readRanges ?? []);
  if (firstUnread === undefined) return undefined;

  const end = Math.min(maxEnd, firstUnread + lookAheadPages - 1);
  return {
    owner: 'system-prefetch',
    source: input.source,
    pageRange: `${firstUnread}-${end}`,
    trigger: input.trigger,
    visiblePage,
    lookAheadPages,
    expectedUse: 'structure-probe',
  };
}

function firstUnreadPage(start: number, end: number, readRanges: string[]): number | undefined {
  for (let page = start; page <= end; page += 1) {
    if (!isPageCovered(page, readRanges)) return page;
  }
  return undefined;
}

function isPageCovered(page: number, readRanges: string[]): boolean {
  return readRanges.some((range) => {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(range.trim());
    if (!match) return false;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    return page >= start && page <= end;
  });
}
