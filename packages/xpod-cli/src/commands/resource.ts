import type { Argv, CommandModule } from 'yargs';
import { writeFileSync } from 'fs';
import { requireAuthContext } from '../lib/auth-context';
import { handleCliError, writeJsonResult } from '../lib/output';
import {
  ensureOk,
  fetchResource,
  parseContainedResources,
  readBodyFile,
  relativeToPodRoot,
  resolveResourceTarget,
  responseData,
} from '../lib/resource';

interface ResourceArgs {
  url?: string;
  json: boolean;
}

interface GetArgs extends ResourceArgs {
  path: string;
  accept?: string;
  out?: string;
}

interface WriteArgs extends ResourceArgs {
  path: string;
  from: string;
  'content-type'?: string;
  'if-match'?: string;
}

interface DeleteArgs extends ResourceArgs {
  path: string;
  'if-match'?: string;
}

interface ListArgs extends ResourceArgs {
  path: string;
  depth: number;
}

function resourceOptions<T>(yargs: Argv): Argv<T> {
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

async function readCommand(argv: GetArgs, method: 'GET' | 'HEAD'): Promise<void> {
  try {
    const context = await requireAuthContext(argv);
    const target = resolveResourceTarget(context, argv.path);
    const headers: Record<string, string> = {};
    if (argv.accept) headers.Accept = argv.accept;

    const response = await fetchResource(context, target, { method, headers });
    ensureOk(response, response.status === 404 ? 'resource_not_found' : 'resource_read_failed', `Failed to ${method} ${argv.path}`);
    const data = responseData(target, response);

    if (method === 'GET') {
      const body = Buffer.from(await response.arrayBuffer());
      if (argv.out) {
        writeFileSync(argv.out, body);
      }

      if (argv.json) {
        writeJsonResult({
          ...data,
          ...(argv.out ? { out: argv.out } : { body: body.toString('utf-8') }),
        });
        return;
      }

      if (!argv.out) {
        process.stdout.write(body);
      }
      return;
    }

    if (argv.json) {
      writeJsonResult(data);
      return;
    }

    for (const [ key, value ] of Object.entries(data.headers)) {
      console.log(`${key}: ${value}`);
    }
  } catch (error) {
    handleCliError(error, argv.json);
  }
}

async function writeCommand(argv: WriteArgs, method: 'PUT' | 'PATCH'): Promise<void> {
  try {
    const context = await requireAuthContext(argv);
    const target = resolveResourceTarget(context, argv.path);
    const file = readBodyFile(argv.from);
    const headers: Record<string, string> = {
      'Content-Type': argv['content-type'] ?? file.contentType,
    };
    if (argv['if-match']) headers['If-Match'] = argv['if-match'];

    const response = await fetchResource(context, target, {
      method,
      headers,
      body: file.body,
    });
    ensureOk(response, 'resource_write_failed', `Failed to ${method} ${argv.path}`);
    const data = responseData(target, response);

    if (argv.json) {
      writeJsonResult(data);
      return;
    }
    console.log(`${method} ${data.resourceUrl} -> HTTP ${data.status}`);
  } catch (error) {
    handleCliError(error, argv.json);
  }
}

export const getCommand: CommandModule<object, GetArgs> = {
  command: 'get <path>',
  describe: 'Read a raw Pod resource',
  builder: (yargs) =>
    resourceOptions<GetArgs>(yargs)
      .positional('path', { type: 'string', demandOption: true, description: 'Pod-root relative path or absolute URL' })
      .option('accept', { type: 'string', description: 'Accept header' })
      .option('out', { type: 'string', description: 'Write response body to file' }),
  handler: (argv) => readCommand(argv, 'GET'),
};

export const headCommand: CommandModule<object, GetArgs> = {
  command: 'head <path>',
  describe: 'Read raw Pod resource metadata',
  builder: (yargs) =>
    resourceOptions<GetArgs>(yargs)
      .positional('path', { type: 'string', demandOption: true, description: 'Pod-root relative path or absolute URL' })
      .option('accept', { type: 'string', description: 'Accept header' }),
  handler: (argv) => readCommand(argv, 'HEAD'),
};

export const putCommand: CommandModule<object, WriteArgs> = {
  command: 'put <path>',
  describe: 'Write a raw Pod resource',
  builder: (yargs) =>
    resourceOptions<WriteArgs>(yargs)
      .positional('path', { type: 'string', demandOption: true, description: 'Pod-root relative path or absolute URL' })
      .option('from', { type: 'string', demandOption: true, description: 'Local file to upload' })
      .option('content-type', { type: 'string', description: 'Content-Type header' })
      .option('if-match', { type: 'string', description: 'If-Match header for stale-write protection' }),
  handler: (argv) => writeCommand(argv, 'PUT'),
};

export const patchCommand: CommandModule<object, WriteArgs> = {
  command: 'patch <path>',
  describe: 'Patch a raw Pod resource',
  builder: (yargs) =>
    resourceOptions<WriteArgs>(yargs)
      .positional('path', { type: 'string', demandOption: true, description: 'Pod-root relative path or absolute URL' })
      .option('from', { type: 'string', demandOption: true, description: 'Local patch/update file' })
      .option('content-type', { type: 'string', description: 'Content-Type header' })
      .option('if-match', { type: 'string', description: 'If-Match header for stale-write protection' }),
  handler: (argv) => writeCommand(argv, 'PATCH'),
};

export const deleteCommand: CommandModule<object, DeleteArgs> = {
  command: 'delete <path>',
  describe: 'Delete a raw Pod resource',
  builder: (yargs) =>
    resourceOptions<DeleteArgs>(yargs)
      .positional('path', { type: 'string', demandOption: true, description: 'Pod-root relative path or absolute URL' })
      .option('if-match', { type: 'string', description: 'If-Match header for stale-write protection' }),
  handler: async (argv) => {
    try {
      const context = await requireAuthContext(argv);
      const target = resolveResourceTarget(context, argv.path);
      const headers: Record<string, string> = {};
      if (argv['if-match']) headers['If-Match'] = argv['if-match'];

      const response = await fetchResource(context, target, { method: 'DELETE', headers });
      ensureOk(response, response.status === 404 ? 'resource_not_found' : 'resource_delete_failed', `Failed to DELETE ${argv.path}`);
      const data = responseData(target, response);
      if (argv.json) {
        writeJsonResult(data);
        return;
      }
      console.log(`DELETE ${data.resourceUrl} -> HTTP ${data.status}`);
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};

export const listCommand: CommandModule<object, ListArgs> = {
  command: 'list <path>',
  describe: 'List a raw Pod container resource',
  builder: (yargs) =>
    resourceOptions<ListArgs>(yargs)
      .positional('path', { type: 'string', demandOption: true, description: 'Pod-root relative container path or absolute URL' })
      .option('depth', { type: 'number', default: 1, description: 'List depth. Only depth=1 is currently supported.' }),
  handler: async (argv) => {
    try {
      if (argv.depth !== 1) {
        throw new Error('Only --depth 1 is currently supported.');
      }
      const context = await requireAuthContext(argv);
      const target = resolveResourceTarget(context, argv.path.endsWith('/') ? argv.path : `${argv.path}/`);
      const response = await fetchResource(context, target, {
        method: 'GET',
        headers: { Accept: 'text/turtle' },
      });
      ensureOk(response, response.status === 404 ? 'resource_not_found' : 'container_list_failed', `Failed to list ${argv.path}`);
      const turtle = await response.text();
      const resources = parseContainedResources(turtle, target.resourceUrl).map((url) => ({
        url,
        path: relativeToPodRoot(url, context.podRoot),
      }));
      const data = {
        ...responseData(target, response),
        resources,
      };
      if (argv.json) {
        writeJsonResult(data);
        return;
      }
      for (const resource of resources) {
        console.log(resource.path);
      }
    } catch (error) {
      handleCliError(error, argv.json);
    }
  },
};
