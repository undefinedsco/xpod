import {
  BadRequestHttpError,
  getTemplateFilePath,
  HandlebarsTemplateEngine,
  resolveAssetPath,
  type TemplateEngineInput,
} from '@solid/community-server';

// Trust exact upstream RDF templates, not a filename suffix supplied by a caller.
// All other templates retain CSS's normal HTML escaping (including Markdown).
const iriVariablesByTemplate = new Map<string, readonly string[]>(([
  ['base/profile/card$.ttl.hbs', ['webId', 'oidcIssuer']],
  ['wac/.acl.hbs', ['webId', 'email']],
  ['wac/README.acl.hbs', ['webId']],
  ['wac/profile/card.acl.hbs', ['webId']],
  ['acp/.acr.hbs', ['webId']],
] as const).map(([template, variables]) => [resolveAssetPath(`@css:templates/pod/${template}`), variables]));

function validateIri(value: unknown, field: string): string {
  // Turtle IRIREF forbids these characters. The /u surrogate range only rejects
  // unpaired UTF-16 surrogates, not valid supplementary Unicode code points.
  if (typeof value !== 'string' || !value || /[\u0000-\u0020<>"{}|^`\\\uD800-\uDFFF]/u.test(value)) {
    throw new BadRequestHttpError(`Invalid RDF IRI in ${field}.`);
  }
  const iri = field === 'email' ? `mailto:${value}` : value;
  try {
    const parsed = new URL(iri);
    if (field === 'email' ? parsed.protocol !== 'mailto:' :
      !['http:', 'https:'].includes(parsed.protocol) || Boolean(parsed.username || parsed.password)) {
      throw new Error('Unsupported IRI');
    }
  } catch {
    throw new BadRequestHttpError(`Invalid RDF IRI in ${field}.`);
  }
  return value;
}

/** Preserve exact identity IRIs in the controlled CSS Profile and ACL/ACR templates. */
export class RdfHandlebarsTemplateEngine extends HandlebarsTemplateEngine {
  /** @param baseUrl - Base URL used by the CSS template engine. */
  public constructor(baseUrl: string) {
    super(baseUrl);
  }

  public override async handle(input: TemplateEngineInput<NodeJS.Dict<unknown>>): Promise<string> {
    const file = getTemplateFilePath(input.template);
    const variables = file ? iriVariablesByTemplate.get(file) : undefined;
    if (!variables) return super.handle(input);

    const contents = { ...input.contents };
    for (const field of variables) {
      const value = contents[field];
      if (field !== 'webId' && (value === undefined || value === '' || value === null)) continue;
      const iri = validateIri(value, field);
      // Handlebars's SafeString interface is toHTML(). Only validated IRI values
      // receive it; names/literals and all uncontrolled templates remain escaped.
      contents[field] = { toHTML: () => iri, toString: () => iri };
    }
    return super.handle({ ...input, contents });
  }
}
