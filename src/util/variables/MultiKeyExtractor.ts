import { ShorthandExtractor } from '@solid/community-server';

export interface MultiKeyExtractorOptions {
  keys: string[];
  defaultValue?: string;
}

/**
 * Extracts the first defined value from a list of possible keys.
 * Useful when both CLI 参数 (camelCase) 和环境变量（大写）需要被支持。
 */
export class MultiKeyExtractor extends ShorthandExtractor {
  private readonly keys: string[];
  private readonly defaultValue?: string;

  public constructor(options: MultiKeyExtractorOptions) {
    super();
    if (!options.keys || options.keys.length === 0) {
      throw new Error('MultiKeyExtractor requires at least one key.');
    }
    this.keys = options.keys;
    this.defaultValue = options.defaultValue;
  }

  public override async handle(args: Record<string, unknown>): Promise<unknown> {
    for (const key of this.keys) {
      if (typeof args[key] !== 'undefined') {
        return args[key];
      }
    }
    return this.defaultValue;
  }
}
