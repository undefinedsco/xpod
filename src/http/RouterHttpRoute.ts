import { HttpHandler } from '@solid/community-server';

export class RouterHttpRoute {
  public readonly basePath: string;
  public readonly handler: HttpHandler;

  public constructor(basePath: string, handler: HttpHandler) {
    this.basePath = basePath;
    this.handler = handler;
  }
}
