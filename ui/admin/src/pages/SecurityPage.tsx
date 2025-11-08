import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';
import { InfoCard } from '../components/InfoCard';
import { ShieldIcon } from '../components/icons';

export function SecurityPage(): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <PageHeader title={t('security.title')} subtitle={t('security.summary')} />
      <div className="grid gap-4 md:grid-cols-2">
        <InfoCard
          title="API tokens"
          description="Token lifecycle and audit trails will live here."
          icon={<ShieldIcon className="h-8 w-8" />}
        />
        <InfoCard
          title="Operational tooling"
          description="Link SSH bastions, trigger maintenance and export audit logs."
          icon={<ShieldIcon className="h-8 w-8" />}
        />
      </div>
    </div>
  );
}
