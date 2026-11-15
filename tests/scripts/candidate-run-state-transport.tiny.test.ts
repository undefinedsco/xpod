import {test,expect} from 'bun:test';
import {candidateNonterminalRunState,CANDIDATE_NONTERMINAL_RUN_STATUSES}
  from '../../scripts/lib/independent-admission/candidate-run-state';
import {observedGitHubRunStateAccepted} from '../../scripts/lib/independent-admission/github-origin';

/** RC383 (run 42343144301 attempt 1, source 0a8974ee) failed at
 * scripts/acquire-independent-product-input.ts with `Artifact acquisition:
 * untrusted producer run`. The captured attempt header was `status:"queued"`
 * /`conclusion:null` while the same-attempt `build_image` job (128317812041) had
 * already completed successfully. The private-issued candidate origin proof had
 * already admitted the call, so only the separate transport header guard
 * disagreed. These tests pin the ONE shared classification and prove it never
 * becomes success evidence. */
test('the shared candidate classification accepts only conclusion-less non-terminal headers',()=>{
  for(const status of CANDIDATE_NONTERMINAL_RUN_STATUSES)
    expect(candidateNonterminalRunState(status,null)).toBe(true);
  // The real RC383 shape.
  expect(candidateNonterminalRunState('queued',null)).toBe(true);
  // Any conclusion on a non-terminal header is never a real GitHub state.
  for(const status of [...CANDIDATE_NONTERMINAL_RUN_STATUSES,'completed'])
    for(const conclusion of ['success','failure','cancelled','timed_out','neutral','skipped','action_required','stale',''])
      expect(candidateNonterminalRunState(status,conclusion)).toBe(false);
  // Terminal statuses are never "non-terminal", and unknown/absent never pass.
  for(const status of ['completed','unknown','',null,undefined,0,{},[]])
    expect(candidateNonterminalRunState(status,null)).toBe(false);
});

test('classification is not a trust decision and grants nothing on its own',()=>{
  // The strict shared predicate is unchanged: it still accepts only
  // `in_progress`, so `queued` is refused there and never becomes admission.
  for(const status of CANDIDATE_NONTERMINAL_RUN_STATUSES)
    expect(observedGitHubRunStateAccepted(status,null,'candidate-producer')).toBe(status==='in_progress');
  // Non-candidate scopes keep exact semantics; only in_progress is live there.
  for(const status of CANDIDATE_NONTERMINAL_RUN_STATUSES){
    expect(observedGitHubRunStateAccepted(status,null,'live-consumer')).toBe(status==='in_progress');
    expect(observedGitHubRunStateAccepted(status,null,'closed-producer')).toBe(false);
  }
  // Completed handling is untouched: failure stays candidate-provisional only.
  expect(observedGitHubRunStateAccepted('completed','success','closed-producer')).toBe(true);
  expect(observedGitHubRunStateAccepted('completed','failure','candidate-producer')).toBe(true);
  expect(observedGitHubRunStateAccepted('completed','failure','live-consumer')).toBe(false);
  for(const conclusion of ['cancelled','timed_out','neutral','skipped','action_required','stale'])
    expect(observedGitHubRunStateAccepted('completed',conclusion,'candidate-producer')).toBe(false);
});
