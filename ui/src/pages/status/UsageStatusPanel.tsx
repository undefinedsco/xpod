import UsagePage, { type AccountUsageKind } from '../dashboard/UsagePage';

export type UsageStatusKind = AccountUsageKind;

export default function UsageStatusPanel({ kind }: { kind: UsageStatusKind }) {
  return <UsagePage kind={kind} embedded />;
}
