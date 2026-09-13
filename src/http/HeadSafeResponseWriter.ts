import { BasicResponseWriter, type HttpResponse, type MetadataWriter, type ResponseDescription } from '@solid/community-server';

/** Preserve HEAD semantics even on runtimes that stream an error representation. */
export class HeadSafeResponseWriter extends BasicResponseWriter {
  public constructor(metadataWriter: MetadataWriter) {
    super(metadataWriter);
  }

  public override async handle(input: { response: HttpResponse; result: ResponseDescription }): Promise<void> {
    if (input.response.req.method !== 'HEAD') {
      return super.handle(input);
    }

    // HEAD errors still have a representation in CSS. Node suppresses writes
    // itself, but Bun 1.3.8 sends them, breaking the gateway's HTTP parser.
    // Close the unused source and keep status/metadata without streaming it.
    input.result.data?.destroy();
    await super.handle({ ...input, result: { ...input.result, data: undefined } });
  }
}
