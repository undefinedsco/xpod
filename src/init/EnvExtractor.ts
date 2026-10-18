import { ShorthandExtractor } from '@solid/community-server';

/** Deployment secrets bypass the CLI/shorthand map and have one canonical environment key. */
export class EnvExtractor extends ShorthandExtractor {
  public constructor(private readonly key: string) { super(); }
  public async handle(): Promise<string> { return process.env[this.key] ?? ''; }
}
