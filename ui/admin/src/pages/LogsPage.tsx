import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';
import { ClipboardIcon } from '../components/icons';
import { InfoCard } from '../components/InfoCard';

export function LogsPage(): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <PageHeader title={t('logs.title')} subtitle={t('logs.summary')} />
      <InfoCard
        title="Recent events"
        description="Attach the log streaming endpoint or forward logs into your preferred SIEM."
        icon={<ClipboardIcon className="h-8 w-8" />}
      />
    </div>
  );
}
