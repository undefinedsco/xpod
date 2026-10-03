/**
 * Formal per-request budget for the Matrix acceptance script.
 *
 * The 300s budget is part of the acceptance contract and must not be silently
 * relaxed. A shorter override is honoured only when the opt-in diagnostics flag
 * (`XPOD_MATRIX_DIAG=1`) is explicitly set for bounded stall investigation; the
 * normal/CI path always gets the formal value regardless of the environment.
 */
export const FORMAL_MATRIX_REQUEST_BUDGET_MS = 300_000;

export function resolveMatrixRequestBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.XPOD_MATRIX_DIAG !== '1') {
    return FORMAL_MATRIX_REQUEST_BUDGET_MS;
  }
  const override = env.XPOD_MATRIX_REQUEST_BUDGET_MS;
  if (override === undefined || override === '') {
    return FORMAL_MATRIX_REQUEST_BUDGET_MS;
  }
  const parsed = Number(override);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : FORMAL_MATRIX_REQUEST_BUDGET_MS;
}
