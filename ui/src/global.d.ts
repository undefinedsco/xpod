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
        [key: string]: any;
      };
      authenticating?: boolean;
      error?: {
        message: string;
        [key: string]: any;
      } | null;
      prefilled?: Record<string, string>;
    };
  }
}