import { AgentGroupAccessChecker } from '@solidlab/policy-engine';
import type { AccessCheckerArgs, WacAuthValidation } from '@solidlab/policy-engine';
import { authoritySnapshotContext } from '../storage/AuthoritySnapshotContext';

/**
 * Equal-interface override of the WAC group access checker for the scoped-write authority snapshot.
 *
 * Outside a strict authority attempt the ordinary CSS group semantics are used unchanged, so legacy
 * queries, public/direct grants and remote groups behave exactly as before. Inside a strict authority
 * attempt (a variable-GRAPH existence guard), a group grant is refused outright: the default checker
 * fetches group documents over independent HTTP that the snapshot cannot freeze, and a dependency map
 * entry alone does not prove the fetched membership data was frozen. Group-only grants therefore fail
 * closed until a truly tracked local ResourceStore group implementation exists. Direct
 * `acl:agent`/`acl:agentClass` grants are checked by other checkers and are not affected here.
 */
export class StrictAgentGroupAccessChecker extends AgentGroupAccessChecker {
  public override async handle(args: AccessCheckerArgs): Promise<WacAuthValidation> {
    const state = authoritySnapshotContext.getStore();
    if (!state) {
      return await super.handle(args);
    }
    const groups = args.auth.agentGroup
      .filter((term): term is typeof term & { value: string } => term.termType === 'NamedNode')
      .map(term => term.value);
    if (groups.length > 0) {
      return { auth: args.auth, agentGroup: { success: false, reason: 'group grants are not authority-tracked local dependencies' } };
    }
    return await super.handle(args);
  }
}
