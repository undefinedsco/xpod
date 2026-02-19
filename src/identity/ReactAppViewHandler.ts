import {
  BasicRepresentation,
  cleanPreferences,
  getTypeWeight,
  APPLICATION_JSON,
  TEXT_HTML,
  MethodNotAllowedHttpError,
  NotImplementedHttpError,
  InteractionHandler,
} from '@solid/community-server';
import type {
  InteractionHandlerInput,
  InteractionRoute,
  Representation,
} from '@solid/community-server';
import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT } from '../runtime';

/**
 * Entry for a single HTML view template.
 * Compatible with CSS's HtmlViewEntry interface.
 */
export interface HtmlViewEntry {
  route: InteractionRoute;
  filePath: string;
}

/**
 * A unified view handler that returns the same React app HTML for all identity routes.
 * The React app determines what to render based on window.location.pathname.
 * 
 * This is a drop-in replacement for CSS's HtmlViewHandler.
 * It ignores individual template files and serves a single static HTML for all routes
 * under the index path.
 */
export class ReactAppViewHandler extends InteractionHandler {
  private readonly idpIndex: string;
  private readonly htmlTemplate: string;

  /**
   * @param index - The root interaction route (provides idpIndex URL)
   * @param htmlFile - Path to the static HTML file (relative to cwd)
   * @param templates - Ignored, kept for CSS config compatibility
   * @param templateEngine - Ignored, kept for CSS config compatibility
   */
  public constructor(
    index: InteractionRoute,
    htmlFile: string,
    templates?: HtmlViewEntry[],
    templateEngine?: unknown,
  ) {
    super();
    this.idpIndex = index.getPath();
    
    // Read the static HTML file at startup
    const filePath = path.resolve(PACKAGE_ROOT, htmlFile);
    this.htmlTemplate = fs.readFileSync(filePath, 'utf-8');
  }

  public override async canHandle({ operation }: InteractionHandlerInput): Promise<void> {
    // Only handle GET requests
    if (operation.method !== 'GET') {
      throw new MethodNotAllowedHttpError([operation.method]);
    }

    // Only return HTML when it's preferred over JSON
    const preferences = cleanPreferences(operation.preferences.type);
    const htmlWeight = getTypeWeight(TEXT_HTML, preferences);
    const jsonWeight = getTypeWeight(APPLICATION_JSON, preferences);

    if (jsonWeight >= htmlWeight) {
      throw new NotImplementedHttpError('HTML views are only returned when they are preferred.');
    }

    // Match any path under the index route (e.g., /.account/*)
    const targetPath = operation.target.path;
    if (!targetPath.startsWith(this.idpIndex)) {
      throw new NotImplementedHttpError(`Path ${targetPath} is not under ${this.idpIndex}`);
    }
  }

  public override async handle({ operation, oidcInteraction }: InteractionHandlerInput): Promise<Representation> {
    // Simple template variable replacement
    const html = this.htmlTemplate
      .replace(/\{\{IDP_INDEX\}\}/g, this.idpIndex)
      .replace(/\{\{AUTHENTICATING\}\}/g, String(Boolean(oidcInteraction)));

    return new BasicRepresentation(html, operation.target, TEXT_HTML);
  }
}
