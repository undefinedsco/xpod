/**
 * The slice of jsdom this repository uses.
 *
 * jsdom ships no types of its own and the repository deliberately does not install `@types/jsdom`
 * (see the note in `tests/identity/oidc/RememberedClientGrantHttp.test.ts`), so the surface is
 * declared here: the window is a real DOM window, and the cookie jar exposes the synchronous
 * helpers the tests drive. Keep this list to what the tests actually call - an API that is missing
 * here should be an error, not an `any`.
 */
declare module 'jsdom' {
  /** jsdom re-exports tough-cookie's jar; only the synchronous helpers are declared. */
  export interface JsdomCookie {
    key: string;
    value: string;
    /** tough-cookie reports a session cookie's expiry as the string `'Infinity'`. */
    expires: Date | 'Infinity';
    secure: boolean;
    sameSite?: string;
    path?: string;
    domain?: string;
    httpOnly?: boolean;
  }

  export class CookieJar {
    public setCookieSync(cookie: string, url: string): unknown;
    public getCookieStringSync(url: string): string;
    public getCookiesSync(url: string): JsdomCookie[];
    public removeAllCookiesSync(): void;
  }

  export class VirtualConsole {
    public on(event: string, listener: (error: Error) => void): this;
    public sendTo(console: Console): this;
  }

  export interface JSDOMOptions {
    url?: string;
    cookieJar?: CookieJar;
    virtualConsole?: VirtualConsole;
    referrer?: string;
    runScripts?: 'dangerously' | 'outside-only';
  }

  export class JSDOM {
    public constructor(html?: string, options?: JSDOMOptions);
    /** A DOM window with the document, storage and constructors the tests install globally. */
    public readonly window: Window & typeof globalThis;
    public serialize(): string;
  }
}
