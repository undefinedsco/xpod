import { ParsingHttpHandler, ResponseWriter } from '@solid/community-server';
import type { CredentialsExtractor, HttpHandlerInput, ParsingHttpHandlerArgs } from '@solid/community-server';
import type { LocalPhysicalOperationService } from '../storage/LocalPhysicalOperationService';
import { observePhysicalStream } from '../storage/LocalPhysicalStreamLifetime';

type ResponseWriterInput = Parameters<ResponseWriter['handle']>[0];

/** Keeps CSS's parsing, authorization and error handling inside the same Local physical admission. */
export class LocalPhysicalParsingHttpHandler extends ParsingHttpHandler {
  private readonly physicalResponseWriter: PhysicalResponseWriter;

  public constructor(args: ParsingHttpHandlerArgs, private readonly operationService: LocalPhysicalOperationService,
    private readonly credentialsExtractor?: CredentialsExtractor) {
    const responseWriter = new PhysicalResponseWriter(args.responseWriter);
    super({ ...args, responseWriter });
    this.physicalResponseWriter = responseWriter;
  }

  public override async handle(input: HttpHandlerInput): Promise<void> {
    // Reuse CSS's request-keyed cache: cold token verification may dereference this same server.
    if (this.credentialsExtractor) {
      try { await this.credentialsExtractor.handleSafe(input.request); }
      catch (error) {
        const result = await this.handleError(error, input.request);
        if (result) { await this.physicalResponseWriter.handleSafe({ response: input.response, result }); }
        return;
      }
    }
    return this.operationService.run(() => super.handle(input));
  }
}

class PhysicalResponseWriter extends ResponseWriter {
  public constructor(private readonly source: ResponseWriter) { super(); }
  public override canHandle(): Promise<void> {
    // Delegate capability validation through source.handleSafe only after observing its owned data.
    return Promise.resolve();
  }
  public override async handle(input: ResponseWriterInput): Promise<void> {
    const stream = input.result.data;
    if (!stream) { await this.source.handleSafe(input); return; }
    const drained = observePhysicalStream(stream);
    const cancel = (): void => { if (!stream.destroyed) { stream.destroy(); } };
    input.response.once('close', cancel);
    try { await this.source.handleSafe(input); }
    catch (error) { cancel(); throw error; }
    finally {
      // Both normal and exceptional writer return retain the original source until actual close.
      await drained;
      input.response.removeListener('close', cancel);
    }
  }
}
