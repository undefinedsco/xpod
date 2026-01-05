declare module 'json-stable-stringify' {
  interface Options {
    cmp?: (a: { key: string; value: unknown }, b: { key: string; value: unknown }) => number;
    space?: string | number;
    replacer?: (key: string, value: unknown) => unknown;
    cycles?: boolean;
  }
  function stringify(obj: unknown, opts?: Options): string;
  export = stringify;
}
