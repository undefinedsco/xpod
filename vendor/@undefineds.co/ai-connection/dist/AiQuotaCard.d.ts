import type { AiQuotaSnapshot } from './ai-connection-client';
export declare function AiQuotaCard({ providerName, quota, busy, disabled, onRefresh, }: {
    providerName: string;
    quota?: AiQuotaSnapshot;
    busy: boolean;
    disabled?: boolean;
    onRefresh: () => void;
}): import("react").JSX.Element;
