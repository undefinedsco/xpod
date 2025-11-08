import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';
import { InfoCard } from '../components/InfoCard';
import { SparklesIcon } from '../components/icons';
import { useAdminConfig } from '../context/AdminConfigContext';

export function QuotaPage(): JSX.Element {
  const { t } = useTranslation();
  const config = useAdminConfig();

  return (
    <div className="space-y-6">
      <PageHeader title={t('quota.title')} subtitle={t('quota.summary')} />
      {config.features.quota ? (
        <div className="grid gap-4 md:grid-cols-2">
          <InfoCard
            title="Quota enforcement"
            description="Account and pod quotas are enforced through the UsageTrackingStore."
            icon={<SparklesIcon className="h-8 w-8" />}
            footer="Adjust limits per account or pod via the quota API or upcoming UI actions."
          />
          <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-400">
            <p>
              Configure billing webhooks to mirror quota events into your metering platform. Upcoming iterations will
              surface quick actions to sync limits, export usage snapshots, and reconcile pods across clusters.
            </p>
          </div>
        </div>
      ) : (
        <InfoCard
          title={t('navigation.quota')}
          description={t('edition.clusterOnly')}
          icon={<SparklesIcon className="h-8 w-8" />}
          footer={t('edition.localHint')}
        />
      )}
    </div>
  );
}
