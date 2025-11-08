import { SuffixIdentifierGenerator } from '@solid/community-server';
import type { ResourceIdentifier } from '@solid/community-server';
import { BadRequestHttpError } from '@solid/community-server/dist/util/errors/BadRequestHttpError';
import { sanitizeUrlPart } from '@solid/community-server/dist/util/StringUtil';

interface ReservedSuffixIdentifierGeneratorOptions {
  baseUrl: string;
  reserved?: string[];
}

const DEFAULT_RESERVED = [ 'admin', 'quota', 'signal' ];

export class ReservedSuffixIdentifierGenerator {
  private readonly inner: SuffixIdentifierGenerator;
  private readonly reserved: Set<string>;

  public constructor(options: ReservedSuffixIdentifierGeneratorOptions) {
    const { baseUrl, reserved } = options;
    this.inner = new SuffixIdentifierGenerator(baseUrl);
    this.reserved = new Set(
      (reserved ?? DEFAULT_RESERVED).map((value) => sanitizeUrlPart(value).toLowerCase()),
    );
  }

  public generate(name: string): ResourceIdentifier {
    const cleanName = sanitizeUrlPart(name);
    if (this.reserved.has(cleanName.toLowerCase())) {
      throw new BadRequestHttpError(`Pod identifier '${cleanName}' is reserved.`);
    }
    return this.inner.generate(name);
  }

  public extractPod(identifier: ResourceIdentifier): ResourceIdentifier {
    return this.inner.extractPod(identifier);
  }
}
