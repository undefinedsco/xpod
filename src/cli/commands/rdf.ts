import type { Argv, CommandModule } from 'yargs';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { podSchema } from '@undefineds.co/models';
import { requireAuthContext } from '../lib/auth-context';
import { handleCliError, writeJsonResult } from '../lib/output';
import {
  ensureOk,
  fetchResource,
  resolveResourceTarget,
  responseData,
} from '../lib/resource';

interface RdfArgs {
  url?: string;
  json: boolean;
}

interface RdfGetArgs extends RdfArgs {
  resource: string;
  out?: string;
}

interface RdfPatchArgs extends RdfArgs {
  resource: string;
  insert?: string;
  delete?: string;
  'if-match'?: string;
}

interface RdfQueryArgs extends RdfArgs {
  sparql: string;
  scope?: string;
  out?: string;
}

interface RdfSchemaArgs extends RdfArgs {
  schema?: string;
  field?: string;
}

function rdfOptions<T>(yargs: Argv): Argv<T> {
  return yargs
    .option('url', {
      alias: 'u',
      type: 'string',
      description: 'Server base URL override',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      description: 'Output JSON envelope',
    }) as unknown as Argv<T>;
}

export function readInlineOrFile(value: string): string {
  return existsSync(value) ? readFileSync(value, 'utf-8') : value;
}

export function documentResourceInput(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    const hashIndex = trimmed.indexOf('#');
    return hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  }

  const url = new URL(trimmed);
  url.hash = '';
  return url.toString();
}

function looksLikeSparqlUpdate(value: string): boolean {
  const withoutPrologue = value.replace(/^\s*(?:(?:PREFIX\s+[A-Za-z][\w-]*:\s+<[^>]+>|BASE\s+<[^>]+>)\s*)*/iu, '');
  return /^(?:WITH|INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD)\b/iu.test(withoutPrologue);
}

export function buildSparqlPatch(input: { insert?: string; delete?: string }): string {
  const insert = input.insert?.trim();
  const del = input.delete?.trim();
  if (!insert && !del) {
    throw new Error('Specify --insert and/or --delete.');
  }
  if (insert && !del && looksLikeSparqlUpdate(insert)) {
    return insert;
  }
  if (del && !insert && looksLikeSparqlUpdate(del)) {
    return del;
  }

  const operations: string[] = [];
  if (del) operations.push(`DELETE DATA {\n${del}\n}`);
  if (insert) operations.push(`INSERT DATA {\n${insert}\n}`);
  return operations.join(';\n');
}

export function resolveSparqlEndpoint(podRoot: string, scope?: string): string {
  const base = scope
    ? new URL(scope.replace(/^\/+/, ''), podRoot).toString()
    : podRoot;
  const container = base.endsWith('/') ? base : `${base}/`;
  return new URL('-/sparql', container).toString();
}

const getCommand: CommandModule<object, RdfGetArgs> = {
  command: 'get <resource>',
  describe: 'Read an RDF resource as Turtle',
  builder: (yargs) =>
    rdfOptions<RdfGetArgs>(yargs)
      .positional('resource', { type: 'string', demandOption: true, description: 'RDF resource or subject URL/path' })
      .option('out', { type: 'string', description: 'Write response body to file' }),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const target = resolveResourceTarget(context, documentResourceInput(argv.resource));
      const response = await fetchResource(context, target, {
        method: 'GET',
        headers: { Accept: 'text/turtle' },
      });
      ensureOk(response, response.status === 404 ? 'resource_not_found' : 'rdf_get_failed', `Failed to read RDF resource ${argv.resource}`);
      const text = await response.text();
      if (argv.json) {
        writeJsonResult({ ...responseData(target, response), body: text });
        return;
      }
      if (argv.out) {
        writeFileSync(argv.out, text, 'utf-8');
        return;
      }
      process.stdout.write(text);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const patchCommand: CommandModule<object, RdfPatchArgs> = {
  command: 'patch <resource>',
  describe: 'Patch an RDF resource with SPARQL Update',
  builder: (yargs) =>
    rdfOptions<RdfPatchArgs>(yargs)
      .positional('resource', { type: 'string', demandOption: true, description: 'RDF resource path or URL' })
      .option('insert', { type: 'string', description: 'Triple snippet, SPARQL update, or file to insert' })
      .option('delete', { type: 'string', description: 'Triple snippet, SPARQL update, or file to delete' })
      .option('if-match', { type: 'string', description: 'If-Match header for stale-write protection' })
      .check((argv) => {
        if (!argv.insert && !argv.delete) {
          throw new Error('Specify --insert and/or --delete.');
        }
        return true;
      }),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const target = resolveResourceTarget(context, documentResourceInput(argv.resource));
      const sparql = buildSparqlPatch({
        insert: argv.insert ? readInlineOrFile(argv.insert) : undefined,
        delete: argv.delete ? readInlineOrFile(argv.delete) : undefined,
      });
      const headers: Record<string, string> = { 'Content-Type': 'application/sparql-update' };
      if (argv['if-match']) headers['If-Match'] = argv['if-match'];
      const response = await fetchResource(context, target, {
        method: 'PATCH',
        headers,
        body: sparql,
      });
      ensureOk(response, 'rdf_patch_failed', `Failed to patch RDF resource ${argv.resource}`);
      const data = responseData(target, response);
      if (argv.json) {
        writeJsonResult(data);
        return;
      }
      console.log(`PATCH ${data.resourceUrl} -> HTTP ${data.status}`);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const queryCommand: CommandModule<object, RdfQueryArgs> = {
  command: 'query',
  describe: 'Run a read-only SPARQL query against a Pod sidecar endpoint',
  builder: (yargs) =>
    rdfOptions<RdfQueryArgs>(yargs)
      .option('sparql', { type: 'string', demandOption: true, description: 'SPARQL query or local file path' })
      .option('scope', { type: 'string', description: 'Pod-relative container scope. Defaults to the Pod root.' })
      .option('out', { type: 'string', description: 'Write response body to file' }),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const endpoint = resolveSparqlEndpoint(context.podRoot, argv.scope);
      const query = readInlineOrFile(argv.sparql);
      const response = await fetchResource(context, {
        input: endpoint,
        resourceUrl: endpoint,
        webId: context.webId,
        podRoot: context.podRoot,
        baseIri: context.baseIri,
      }, {
        method: 'POST',
        headers: {
          Accept: 'application/sparql-results+json, application/n-quads;q=0.9, text/turtle;q=0.8, */*;q=0.1',
          'Content-Type': 'application/sparql-query',
        },
        body: query,
      });
      ensureOk(response, 'rdf_query_failed', `Failed to query RDF scope ${argv.scope ?? '/'}`);
      const body = await response.text();
      if (argv.json) {
        writeJsonResult({
          endpoint,
          contentType: response.headers.get('content-type') ?? undefined,
          body,
        });
        return;
      }
      if (argv.out) {
        writeFileSync(argv.out, body, 'utf-8');
        return;
      }
      process.stdout.write(body);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

const classesCommand: CommandModule<object, RdfSchemaArgs> = {
  command: 'classes',
  describe: 'List known RDF classes from shared model descriptors',
  builder: (yargs) =>
    rdfOptions<RdfSchemaArgs>(yargs)
      .option('schema', { type: 'string', description: 'Schema URI filter' }),
  handler: (argv) => {
    const classes = podSchema.classes({ schemaUri: argv.schema });
    if (argv.json) {
      writeJsonResult({ classes });
      return;
    }
    for (const entry of classes) {
      console.log(`${entry.schemaUri}\t${entry.class}\t${entry.resourceKind}`);
    }
  },
};

const predicatesCommand: CommandModule<object, RdfSchemaArgs> = {
  command: 'predicates',
  describe: 'List known RDF predicates from shared model descriptors',
  builder: (yargs) =>
    rdfOptions<RdfSchemaArgs>(yargs)
      .option('schema', { type: 'string', description: 'Schema URI filter' })
      .option('field', { type: 'string', description: 'Descriptor field filter' }),
  handler: (argv) => {
    const predicates = podSchema.predicates({ schemaUri: argv.schema, field: argv.field });
    if (argv.json) {
      writeJsonResult({ predicates });
      return;
    }
    for (const entry of predicates) {
      console.log(`${entry.schemaUri}\t${entry.field}\t${entry.predicate}`);
    }
  },
};

export const rdfCommand: CommandModule<object, RdfArgs> = {
  command: 'rdf',
  describe: 'RDF graph/resource operations',
  builder: (yargs) =>
    (yargs
      .command(getCommand)
      .command(patchCommand)
      .command(queryCommand)
      .command(classesCommand)
      .command(predicatesCommand)
      .demandCommand(1, 'Please specify an RDF subcommand') as unknown as Argv<RdfArgs>),
  handler: () => {},
};
