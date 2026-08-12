export interface ReaderMaterializationBodyInput {
  sourceKey: string;
  sourceUri: string;
  sourceHash: string;
  mediaType: string;
  readerEngine: string;
  readerVersion: string;
  modelUri?: string;
  readerOptionsHash: string;
  representationHash: string;
  markdown: string;
}

export interface ReaderMaterializationBody extends ReaderMaterializationBodyInput {
  fingerprint: string;
  createdAt: Date;
}

export interface ReaderReconciliationInput {
  sourceKey: string;
  sourceUri: string;
  desiredFingerprint?: string;
  reason: string;
}

export interface ReaderReconciliationRow {
  sourceKey: string;
  sourceUri: string;
  desiredFingerprint?: string;
  reason: string;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  lastFailureCategory?: string;
  updatedAt: Date;
}
