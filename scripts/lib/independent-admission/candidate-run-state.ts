/** Shared run-state vocabulary for the ONE private candidate role.
 *
 * GitHub's global run header can lag the actual producer job: RC381 and RC383
 * both observed `status:"queued"`/`conclusion:null` while the same-attempt
 * `build_image` job had already completed successfully. A non-terminal header
 * therefore says nothing either way about producer success, and it must never be
 * read as evidence of it.
 *
 * This module deliberately owns NO trust decision. It only classifies a header so
 * that the two callers agree on the same table instead of growing divergent
 * copies. Trust is still established exclusively by the mandatory same-attempt
 * producer job/step/artifact/source/ancestor closure, and every caller keeps its
 * own strict checks. `queued`/`requested`/`waiting`/`pending` are included only as
 * *non-terminal, conclusion-less* states; any conclusion makes them fail.
 *
 * It imports nothing from the acquisition layer, so the independent origin
 * observer and the transport acquirer can share it without a cycle.
 */
export const CANDIDATE_NONTERMINAL_RUN_STATUSES:readonly string[]=Object.freeze(['queued','requested','waiting','pending','in_progress']);

/** TRUE only for a genuinely non-terminal header carrying NO conclusion. This is
 * an observation about the header alone; it never implies producer success. */
export function candidateNonterminalRunState(status:unknown,conclusion:unknown):boolean {
 return conclusion===null && typeof status==='string' && CANDIDATE_NONTERMINAL_RUN_STATUSES.includes(status);
}
