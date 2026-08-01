import { dashboardNavigationItems } from './dashboard-navigation';
import { XpodProductLayout } from './XpodProductLayout';

export function XpodDashboardLayout() {
  return (
    <XpodProductLayout
      product="dashboard"
      items={dashboardNavigationItems}
      switchHref="/settings/models"
    />
  );
}
