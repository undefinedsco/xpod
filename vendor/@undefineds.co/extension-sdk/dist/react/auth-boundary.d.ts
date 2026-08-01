import { type ReactNode } from 'react';
export type AuthBoundaryState = {
    status: 'loading';
} | {
    status: 'anonymous';
} | {
    status: 'authenticated';
} | {
    status: 'error';
    message: string;
};
export interface LoginViewProps {
    title: ReactNode;
    description?: ReactNode;
    defaultIssuer?: string;
    logo?: ReactNode;
    error?: string;
    onLogin: (issuer: string) => void | Promise<void>;
}
export interface AuthBoundaryProps {
    state: AuthBoundaryState;
    login: (issuer: string) => void | Promise<void>;
    children: ReactNode;
    loginView?: Omit<LoginViewProps, 'error' | 'onLogin'>;
}
export declare function LoginView({ title, description, defaultIssuer, logo, error, onLogin, }: LoginViewProps): import("react").JSX.Element;
export declare function AuthBoundary({ state, login, children, loginView, }: AuthBoundaryProps): import("react").JSX.Element;
