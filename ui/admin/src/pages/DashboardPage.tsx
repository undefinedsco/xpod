import { useTranslation } from 'react-i18next';
import { InfoCard } from '../components/InfoCard';
import { PageHeader } from '../components/PageHeader';
import { DashboardIcon, UsersIcon, CubeIcon, SparklesIcon } from '../components/icons';

export function DashboardPage(): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <PageHeader title={t('dashboard.title')} subtitle={t('dashboard.comingSoon')} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <InfoCard
          title={t('navigation.accounts')}
          value="—"
          description={t('accounts.summary')}
          icon={<UsersIcon className="h-8 w-8" />}
        />
        <InfoCard
          title={t('navigation.pods')}
          value="—"
          description={t('pods.summary')}
          icon={<CubeIcon className="h-8 w-8" />}
        />
        <InfoCard
          title={t('navigation.quota')}
          value="—"
          description={t('quota.summary')}
          icon={<SparklesIcon className="h-8 w-8" />}
        />
        <InfoCard
          title={t('navigation.logs')}
          value="—"
          description={t('logs.summary')}
          icon={<DashboardIcon className="h-8 w-8" />}
        />
      </div>
    </div>
  );
}
