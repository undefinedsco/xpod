import { type ReactNode } from 'react';
export interface AppLayoutProps {
    navigation: ReactNode;
    header?: ReactNode;
    children: ReactNode;
    className?: string;
}
export declare function AppLayout({ navigation, header, children, className, }: AppLayoutProps): import("react").JSX.Element;
