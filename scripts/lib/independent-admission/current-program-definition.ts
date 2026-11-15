import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {GitHubSourceBinding, GitHubSourceBindingGroup} from './github-source-binding-groups';
import {QLEVER_NORMAL_SOURCE_GROUPS, QLEVER_SDK_CONSUMER_GROUPS, QLEVER_LINUX_CONSUMER_GROUPS} from './qlever-sdk-origin-policy';

const WORKFLOW = '.github/workflows/candidate.yml';

/** Program-owned expectation data, not an artifact/source qualification capability.
 * The tooling already executes this checkout's code. Read its own declaration,
 * never a caller-selected checkout, artifact claim, environment value or CWD.
 * External runs and their originals still require all existing custody checks.
 *
 * Capture lazily at the tooling boundary so importing policy data does not read
 * a moving workflow, and retain one immutable definition for this process.
 */
let workflowSha256: string | undefined;
function currentWorkflowSha256(): string {
  if (workflowSha256 === undefined) {
    const bytes = readFileSync(fileURLToPath(new URL('../../../' + WORKFLOW, import.meta.url)));
    workflowSha256 = createHash('sha256').update(bytes).digest('hex');
  }
  return workflowSha256;
}

function currentGroup(base: GitHubSourceBindingGroup): GitHubSourceBindingGroup {
  const sha256 = currentWorkflowSha256();
  const rebind = (row: GitHubSourceBinding): GitHubSourceBinding =>
    row.path === WORKFLOW ? Object.freeze({...row, sha256}) : row;
  return Object.freeze({
    ...base,
    selectors: Object.freeze(base.selectors.map(rebind)),
    ...(base.secondarySelectors ? {secondarySelectors: Object.freeze(base.secondarySelectors.map(rebind))} : {}),
    ...(base.secondarySelectorStages ? {secondarySelectorStages: Object.freeze(base.secondarySelectorStages.map(stage => Object.freeze(stage.map(rebind))))} : {}),
    sourceBindings: Object.freeze(base.sourceBindings.map(rebind)),
    ...(base.candidateServiceRelationship ? {candidateServiceRelationship: Object.freeze({...base.candidateServiceRelationship, workflowSha256: sha256})} : {}),
  });
}

function withCurrent(groups: readonly GitHubSourceBindingGroup[]): readonly GitHubSourceBindingGroup[] {
  const base = groups[groups.length - 1];
  if (!base) throw Error('Current program definition requires an existing recipe declaration');
  const current = currentGroup(base);
  // At a historical checkout the CURRENT definition can already be registered.
  // Do not create duplicate selectable groups with identical declarations.
  if (JSON.stringify(current) === JSON.stringify(base)) return groups;
  return Object.freeze([...groups, current]);
}

/** Frozen published recipes plus the one CURRENT program definition. Only the
 * workflow role moves; source/recipe rows, stages and job contracts are inherited.
 * Normal SDK input identity H remains independently calculated from committed
 * recipe bytes by sdk-normal-build-proof.py, including this workflow.
 */
let normalGroups: readonly GitHubSourceBindingGroup[] | undefined;
let sdkGroups: readonly GitHubSourceBindingGroup[] | undefined;
let linuxGroups: readonly GitHubSourceBindingGroup[] | undefined;
export function currentProgramNormalSourceGroups(): readonly GitHubSourceBindingGroup[] {
  return normalGroups ??= withCurrent(QLEVER_NORMAL_SOURCE_GROUPS);
}

export function currentProgramSdkConsumerGroups(): readonly GitHubSourceBindingGroup[] {
  return sdkGroups ??= withCurrent(QLEVER_SDK_CONSUMER_GROUPS);
}

export function currentProgramLinuxConsumerGroups(): readonly GitHubSourceBindingGroup[] {
  return linuxGroups ??= withCurrent(QLEVER_LINUX_CONSUMER_GROUPS);
}
