/**
 * Engine-neutral admission scenarios for the Xpod CLI mount selection
 * (AgentFS vs rclone). Every candidate must be able to execute the SAME dataset
 * and the SAME checks over Pod HTTP; a candidate is not "passing" because it
 * skipped a scenario.
 */
export interface AdmissionScenario {
  id: string;
  description: string;
  /** The HTTP/OS evidence that must be produced for this scenario. */
  evidence: string;
  required: true;
}

export const ADMISSION_SCENARIOS: AdmissionScenario[] = [
  { id: 'metadata-zero-body', description: 'directory enumeration / stat transfer metadata only', evidence: 'external HTTP log shows no body GET/range for readdir/stat', required: true },
  { id: 'correct-range-206', description: 'seek/offset read returns exactly the requested bytes', evidence: 'HTTP 206 with matching Content-Range start; bytes equal the slice', required: true },
  { id: 'external-mutation-visible', description: 'an external Pod writer becomes visible in a bounded revalidation window', evidence: 'reader observes the remote update without a persistent body cache', required: true },
  { id: 'create-409-412', description: 'conditional create conflicts instead of overwriting', evidence: 'second create with If-None-Match:* is refused (409/412), content unchanged', required: true },
  { id: 'conditional-edit-delete', description: 'overwrite/delete require a version baseline', evidence: 'stale If-Match -> 412; unconditional overwrite/delete is refused', required: true },
  { id: 'editor-replace', description: 'editor temp-file replace over an existing target succeeds atomically', evidence: 'rename/copy over existing target replaces it without data loss', required: true },
  { id: 'network-fail', description: 'network failure never fabricates success or clobbers remote', evidence: 'failed write leaves remote unchanged and dirty state retained', required: true },
  { id: '412-preserves-dirty', description: 'a 412 during commit retains the pending operation for retry', evidence: 'non-zero commit result and pending-ops.json still present', required: true },
  { id: 'restart-baseline', description: 'restart restores uncommitted content and the original version baseline', evidence: 'reloaded pending state resumes with the original base version', required: true },
  { id: 'rg-unsupported-falls-back-to-mount-view', description: 'unsupported rg arguments fall back to the real mount view (not an empty placeholder)', evidence: 'rg fallback searches the mounted dataset and returns the same files as the mount', required: true },
];

export type ScenarioRunStatus = 'pass' | 'fail' | 'not-run';

export interface AdmissionEvaluation {
  status: 'pass' | 'fail' | 'incomplete';
  executed: string[];
  failed: string[];
  notRun: string[];
}

/**
 * A candidate can only PASS when EVERY required scenario has actually been
 * executed and passed. Missing scenarios make the result INCOMPLETE, never PASS.
 */
export function evaluateAdmission(results: { id: string; status: ScenarioRunStatus }[]): AdmissionEvaluation {
  const statusById = new Map(results.map((result) => [ result.id, result.status ]));
  const executed: string[] = [];
  const failed: string[] = [];
  const notRun: string[] = [];
  for (const scenario of ADMISSION_SCENARIOS) {
    const run = statusById.get(scenario.id) ?? 'not-run';
    if (run === 'not-run') {
      notRun.push(scenario.id);
    } else {
      executed.push(scenario.id);
      if (run === 'fail') {
        failed.push(scenario.id);
      }
    }
  }
  const status = notRun.length > 0 ? 'incomplete' : failed.length > 0 ? 'fail' : 'pass';
  return { status, executed, failed, notRun };
}

export function missingScenarios(seen: Iterable<string>): string[] {
  const present = new Set(seen);
  return ADMISSION_SCENARIOS.map((scenario) => scenario.id).filter((id) => !present.has(id));
}
