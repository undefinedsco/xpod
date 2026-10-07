import {
  BasicResponseWriter,
  type HttpResponse,
  type MetadataWriter,
  type ResponseDescription,
} from '@solid/community-server';

/** Writes CSS responses without sending a body for HEAD requests. */
export class HeadSafeResponseWriter extends BasicResponseWriter {
  public constructor(metadataWriter: MetadataWriter) {
    super(metadataWriter);
  }

  public override async handle(input: { response: HttpResponse; result: ResponseDescription }): Promise<void> {
    // Error handlers can generate a body even when the request was HEAD.
    // Bun's Node HTTP writer streams it, corrupting the proxy's next HTTP frame.
    if (input.response.req.method === 'HEAD' && input.result.data) {
      input.result.data.destroy();
      await super.handle({ ...input, result: { ...input.result, data: undefined } });
      return;
    }
    await super.handle(input);
  }
}
