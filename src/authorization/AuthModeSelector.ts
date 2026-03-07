import { AsyncHandler } from 'asynchronous-handlers';
import type { PermissionReader, PermissionReaderInput, MultiPermissionMap } from '@solid/community-server';
import { AllStaticReader } from '@solid/community-server';

export class AuthModeSelector extends AsyncHandler<PermissionReaderInput, MultiPermissionMap> {
  private readonly authMode: string;
  private readonly acpReader: PermissionReader;
  private readonly aclReader: PermissionReader;
  private readonly allowAllReader: PermissionReader;

  public constructor(
    authMode: string,
    acpReader: PermissionReader,
    aclReader: PermissionReader,
  ) {
    super();
    this.authMode = authMode || 'acp';
    this.acpReader = acpReader;
    this.aclReader = aclReader;
    this.allowAllReader = new AllStaticReader(true);
  }

  public async handle(input: PermissionReaderInput): Promise<MultiPermissionMap> {
    switch (this.authMode) {
      case 'allow-all':
        return this.allowAllReader.handle(input);
      case 'acl':
        return this.aclReader.handle(input);
      case 'acp':
      default:
        return this.acpReader.handle(input);
    }
  }
}
