import type { CommandModule } from 'yargs';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, dirname } from 'path';
import { login, checkServer } from '../lib/css-account';

interface BackupArgs {
  url: string;
  email: string;
  password: string;
}

interface BackupExportArgs extends BackupArgs {
  output: string;
}

interface BackupImportArgs extends BackupArgs {
  input: string;
}

function resolveUrl(url: string): string {
  const raw = url || process.env.CSS_BASE_URL || 'http://localhost:3000';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

async function loginOrExit(email: string, password: string, baseUrl: string): Promise<string> {
  if (!(await checkServer(baseUrl))) {
    console.error(`Cannot reach server at ${baseUrl}`);
    process.exit(1);
  }
  const token = await login(email, password, baseUrl);
  if (!token) {
    console.error('Login failed. Check email/password.');
    process.exit(1);
  }
  return token;
}

async function resolvePodUrl(token: string, baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}.account/`, {
    headers: {
      Accept: 'application/json',
      Authorization: `CSS-Account-Token ${token}`,
    },
  });
  if (!res.ok) throw new Error('Failed to get account info.');
  const data = (await res.json()) as { pods?: Record<string, string> };
  const podUrl = data.pods ? Object.values(data.pods)[0] : undefined;
  if (!podUrl) throw new Error('No pod found for this account.');
  return podUrl;
}

/**
 * Parse ldp:contains links from a Turtle container listing.
 * Matches both <url> patterns in ldp:contains statements.
 */
function parseContainedUrls(turtle: string, containerUrl: string): string[] {
  const urls: string[] = [];
  // Match URLs in ldp:contains references
  const regex = /<([^>]+)>/g;
  let match: RegExpExecArray | null;
  // Find lines with ldp:contains
  const lines = turtle.split('\n');
  let inContains = false;
  for (const line of lines) {
    if (line.includes('ldp:contains') || line.includes('http://www.w3.org/ns/ldp#contains')) {
      inContains = true;
    }
    if (inContains) {
      while ((match = regex.exec(line)) !== null) {
        const url = match[1];
        // Skip the container itself and vocabulary URIs
        if (url !== containerUrl && !url.startsWith('http://www.w3.org/') && !url.startsWith('http://purl.org/')) {
          urls.push(url);
        }
      }
      if (line.includes('.')) inContains = false;
    }
  }
  return urls;
}

function isContainer(url: string): boolean {
  return url.endsWith('/');
}

interface FetchedResource {
  url: string;
  contentType: string;
  body: Buffer;
}

async function fetchResource(
  url: string,
  token: string,
): Promise<FetchedResource | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `CSS-Account-Token ${token}`,
      },
    });
    if (!res.ok) {
      console.error(`  WARN: GET ${url} → ${res.status}`);
      return null;
    }
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const body = Buffer.from(await res.arrayBuffer());
    return { url, contentType, body };
  } catch (err) {
    console.error(`  WARN: GET ${url} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function fetchContainer(
  containerUrl: string,
  token: string,
): Promise<string | null> {
  try {
    const res = await fetch(containerUrl, {
      headers: {
        Accept: 'text/turtle',
        Authorization: `CSS-Account-Token ${token}`,
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function crawlAndSave(
  containerUrl: string,
  token: string,
  podUrl: string,
  outputDir: string,
  stats: { resources: number; bytes: number },
): Promise<void> {
  const turtle = await fetchContainer(containerUrl, token);
  if (!turtle) {
    console.error(`  WARN: Cannot read container ${containerUrl}`);
    return;
  }

  const contained = parseContainedUrls(turtle, containerUrl);

  for (const url of contained) {
    const relativePath = url.startsWith(podUrl) ? url.slice(podUrl.length) : url;

    if (isContainer(url)) {
      const dirPath = join(outputDir, relativePath);
      mkdirSync(dirPath, { recursive: true });
      await crawlAndSave(url, token, podUrl, outputDir, stats);
    } else {
      const resource = await fetchResource(url, token);
      if (resource) {
        const filePath = join(outputDir, relativePath);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, resource.body);
        stats.resources++;
        stats.bytes += resource.body.length;
        console.error(`  ${relativePath} (${resource.body.length} bytes)`);
      }
    }
  }

  // Also try to fetch .acl for this container
  const aclUrl = `${containerUrl}.acl`;
  const aclResource = await fetchResource(aclUrl, token);
  if (aclResource) {
    const aclRelative = aclUrl.startsWith(podUrl) ? aclUrl.slice(podUrl.length) : `${containerUrl.slice(podUrl.length)}.acl`;
    const aclPath = join(outputDir, aclRelative);
    mkdirSync(dirname(aclPath), { recursive: true });
    writeFileSync(aclPath, aclResource.body);
    stats.resources++;
    stats.bytes += aclResource.body.length;
  }
}

async function restoreFromDir(
  dirPath: string,
  podUrl: string,
  token: string,
  basePath: string,
  stats: { resources: number; bytes: number },
): Promise<void> {
  const entries = readdirSync(dirPath, { withFileTypes: true });

  // Create containers first
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const relativePath = relative(basePath, join(dirPath, entry.name));
      const containerUrl = `${podUrl}${relativePath}/`;
      // PUT an empty container
      try {
        await fetch(containerUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'text/turtle',
            Authorization: `CSS-Account-Token ${token}`,
          },
          body: '',
        });
      } catch {
        // Container may already exist
      }
      await restoreFromDir(join(dirPath, entry.name), podUrl, token, basePath, stats);
    }
  }

  // Then write resources
  for (const entry of entries) {
    if (entry.isFile()) {
      const filePath = join(dirPath, entry.name);
      const relativePath = relative(basePath, filePath);
      const resourceUrl = `${podUrl}${relativePath}`;
      const body = readFileSync(filePath);

      // Guess content type
      let contentType = 'application/octet-stream';
      if (entry.name.endsWith('.ttl')) contentType = 'text/turtle';
      else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonld')) contentType = 'application/ld+json';
      else if (entry.name.endsWith('.acl')) contentType = 'text/turtle';
      else if (entry.name.endsWith('.html')) contentType = 'text/html';
      else if (entry.name.endsWith('.txt')) contentType = 'text/plain';
      else if (entry.name.endsWith('.png')) contentType = 'image/png';
      else if (entry.name.endsWith('.jpg') || entry.name.endsWith('.jpeg')) contentType = 'image/jpeg';

      const res = await fetch(resourceUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          Authorization: `CSS-Account-Token ${token}`,
        },
        body,
      });

      if (res.ok) {
        stats.resources++;
        stats.bytes += body.length;
        console.error(`  ${relativePath} (${body.length} bytes)`);
      } else {
        console.error(`  WARN: PUT ${resourceUrl} → ${res.status}`);
      }
    }
  }
}

const backupCommand: CommandModule<object, BackupExportArgs> = {
  command: 'backup',
  describe: 'Backup a Pod to a local directory',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' })
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL',
        default: process.env.CSS_BASE_URL || 'http://localhost:3000',
      })
      .option('output', {
        alias: 'o',
        type: 'string',
        demandOption: true,
        description: 'Output directory path',
      }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);
    const token = await loginOrExit(argv.email, argv.password, baseUrl);

    let podUrl: string;
    try {
      podUrl = await resolvePodUrl(token, baseUrl);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    console.log(`Backing up pod: ${podUrl}`);
    console.log(`Output: ${argv.output}\n`);

    mkdirSync(argv.output, { recursive: true });
    const stats = { resources: 0, bytes: 0 };

    await crawlAndSave(podUrl, token, podUrl, argv.output, stats);

    console.log(`\nBackup complete: ${stats.resources} resources, ${(stats.bytes / 1024).toFixed(1)} KB`);
  },
};

const restoreCommand: CommandModule<object, BackupImportArgs> = {
  command: 'restore',
  describe: 'Restore a Pod from a local backup directory',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', demandOption: true, description: 'Account email' })
      .option('password', { type: 'string', demandOption: true, description: 'Account password' })
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL',
        default: process.env.CSS_BASE_URL || 'http://localhost:3000',
      })
      .option('input', {
        alias: 'i',
        type: 'string',
        demandOption: true,
        description: 'Input directory path',
      }),
  handler: async (argv) => {
    const baseUrl = resolveUrl(argv.url);

    if (!existsSync(argv.input) || !statSync(argv.input).isDirectory()) {
      console.error(`Input path is not a directory: ${argv.input}`);
      process.exit(1);
    }

    const token = await loginOrExit(argv.email, argv.password, baseUrl);

    let podUrl: string;
    try {
      podUrl = await resolvePodUrl(token, baseUrl);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    console.log(`Restoring to pod: ${podUrl}`);
    console.log(`Input: ${argv.input}\n`);

    const stats = { resources: 0, bytes: 0 };
    await restoreFromDir(argv.input, podUrl, token, argv.input, stats);

    console.log(`\nRestore complete: ${stats.resources} resources, ${(stats.bytes / 1024).toFixed(1)} KB`);
  },
};

export { backupCommand, restoreCommand };
