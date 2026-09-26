/**
 * The slice of `bun:test` this repository uses.
 *
 * `tests/bun/*` runs under `bun test`, not vitest, and the repository does not install `@types/bun`
 * (that would also add Bun's globals to every other program). Only the helpers the suite calls are
 * declared here; a Bun test API that is not listed should be a type error rather than an `any`.
 */
declare module 'bun:test' {
  type TestBody = () => void | Promise<void>;

  export interface Expectation {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatchObject(expected: unknown): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toThrow(expected?: string | RegExp): void;
    readonly not: Expectation;
    readonly resolves: Expectation;
    readonly rejects: Expectation;
  }

  export function describe(name: string, body: TestBody): void;
  export function test(name: string, body: TestBody, timeout?: number): void;
  export const it: typeof test;
  export function beforeAll(body: TestBody): void;
  export function beforeEach(body: TestBody): void;
  export function afterEach(body: TestBody): void;
  export function afterAll(body: TestBody): void;
  export function expect(value: unknown): Expectation;
}
