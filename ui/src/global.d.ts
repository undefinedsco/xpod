export {};

declare global {
  interface Window {
    __INITIAL_DATA__: {
      mode?: 'login' | 'register' | 'forgot-password' | 'reset-password';
      idpIndex: {
        login?: string;
        register?: string;
        password?: {
          login?: string;
          register?: string;
        };
        oidc?: {
          prompt?: string;
        };
        [key: string]: unknown;
      };
      authenticating?: boolean;
      error?: {
        message: string;
        [key: string]: unknown;
      } | null;
      prefilled?: Record<string, string>;
    };
  }
}
