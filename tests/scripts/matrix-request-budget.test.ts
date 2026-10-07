import { describe, expect, it } from 'vitest';
import { FORMAL_MATRIX_REQUEST_BUDGET_MS, resolveMatrixRequestBudgetMs } from '../../scripts/matrix-request-budget';

describe('Matrix acceptance request budget', () => {
  it('keeps the formal 300s budget on the normal path regardless of environment', () => {
    expect(FORMAL_MATRIX_REQUEST_BUDGET_MS).toBe(300_000);
    expect(resolveMatrixRequestBudgetMs({})).toBe(300_000);
    expect(resolveMatrixRequestBudgetMs({ XPOD_MATRIX_REQUEST_BUDGET_MS: '1' })).toBe(300_000);
    expect(resolveMatrixRequestBudgetMs({ XPOD_MATRIX_DIAG: '0', XPOD_MATRIX_REQUEST_BUDGET_MS: '1' })).toBe(300_000);
  });

  it('honours a positive override only when diagnostics are explicitly enabled', () => {
    expect(resolveMatrixRequestBudgetMs({ XPOD_MATRIX_DIAG: '1', XPOD_MATRIX_REQUEST_BUDGET_MS: '45_000' })).toBe(300_000);
    expect(resolveMatrixRequestBudgetMs({ XPOD_MATRIX_DIAG: '1', XPOD_MATRIX_REQUEST_BUDGET_MS: '45000' })).toBe(45_000);
    expect(resolveMatrixRequestBudgetMs({ XPOD_MATRIX_DIAG: '1', XPOD_MATRIX_REQUEST_BUDGET_MS: '0' })).toBe(300_000);
    expect(resolveMatrixRequestBudgetMs({ XPOD_MATRIX_DIAG: '1', XPOD_MATRIX_REQUEST_BUDGET_MS: '-5' })).toBe(300_000);
    expect(resolveMatrixRequestBudgetMs({ XPOD_MATRIX_DIAG: '1' })).toBe(300_000);
  });
});
