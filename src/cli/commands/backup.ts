import type { CommandModule } from 'yargs';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, dirname } from 'path';
import { login, checkServer } from '../lib/css-account';
import { loadCredentials, getClientCredentials } from '../lib/credentials-store';
import { getAccessToken } from '../lib/solid-auth';

interface BackupArgs {
  url?: string;
  email?: string;
  password?: string;
}

interface BackupExportArgs extends BackupArgs {
  output: string;
}

interface BackupImportArgs extends BackupArgs {
  input: string;
}

function resolveUrl(url?: string, credUrl?: string): string {
  const raw = url || credUrl || process.env.CSS_BASE_URL || 'http://localhost:3000';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/**
 * Resolve auth: prefer client credentials from ~/.xpod/, fall back to email/password.
 * Returns { authHeader, podUrl }.
 */
async function resolveBackupAuth(
  argv: BackupArgs,
): Promise<{ authHeader: string; podUrl: string }> {
  const creds = loadCredentials();

  // Try client credentials first
  if (creds) {
    const clientCreds = getClientCredentials(creds);
    if (clientCreds) {
      const baseUrl = resolveUrl(argv.url, creds.url);
      const tokenResult = await getAccessToken(clientCreds.clientId, clientCreds.clientSecret, baseUrl);
      if (tokenResult) {
        // Derive pod URL from webId
        const webIdUrl = new URL(creds.webId);
        const pathParts = webIdUrl.pathname.split('/').filter(Boolean);
        const podUrl = `${webIdUrl.origin}/${pathParts[0]}/`;
        return { authHeader: `Bearer ${tokenResult.accessToken}`, podUrl };
      }
    }
  }

  // Fall back to email/password
  if (!argv.email || !argv.password) {
    console.error('No credentials found. Run `xpod auth create-credentials` or provide --email and --password.');
    process.exit(1);
  }

  const baseUrl = resolveUrl(argv.url, creds?.url);
  if (!(await checkServer(baseUrl))) {
    console.error(`Cannot reach server at ${baseUrl}`);
    process.exit(1);
  }

  const token = await login(argv.email, argv.password, baseUrl);
  if (!token) {
    console.error('Login failed. Check email/password.');
    process.exit(1);
  }

  // Resolve pod URL via account API
  const res = await fetch(`${baseUrl}.account/`, {
    headers: {
      Accept: 'application/json',
      Authorization: `CSS-Account-Token ${token}`,
    },
  });
  if (!res.ok) {
    console.error('Failed to get account info.');
    process.exit(1);
  }
  const data = (await res.json()) as { pods?: Record<string, string> };
  const podUrl = data.pods ? Object.values(data.pods)[0] : undefined;
  if (!podUrl) {
    console.error('No pod found for this account.');
    process.exit(1);
  }

  return { authHeader: `CSS-Account-Token ${token}`, podUrl };
}

/**
 * Parse ldp:contains links from a Turtle container listing.
 */
function parseContainedUrls(turtle: string, containerUrl: string): string[] {
  const urls: string[] = [];
  const regex = /<([^>]+)>/g;
  let match: RegExpExecArray | null;
  const lines = turtle.split('\n');
  let inContains = false;
  for (const line of lines) {
    if (line.includes('ldp:contains') || line.includes('http://www.w3.org/ns/ldp#contains')) {
      inContains = true;
    }
    if (inContains) {
      while ((match = regex.exec(line)) !== null) {
        const url = match[1];
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
  authHeader: string,
): Promise<FetchedResource | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: authHeader },
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
  authHeader: string,
): Promise<string | null> {
  try {
    const res = await fetch(containerUrl, {
      headers: {
        Accept: 'text/turtle',
        Authorization: authHeader,
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
  authHeader: string,
  podUrl: string,
  outputDir: string,
  stats: { resources: number; bytes: number },
): Promise<void> {
  const turtle = await fetchContainer(containerUrl, authHeader);
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
      await crawlAndSave(url, authHeader, podUrl, outputDir, stats);
    } else {
      const resource = await fetchResource(url, authHeader);
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

  const aclUrl = `${containerUrl}.acl`;
  const aclResource = await fetchResource(aclUrl, authHeader);
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
  authHeader: string,
  basePath: string,
  stats: { resources: number; bytes: number },
): Promise<void> {
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const relativePath = relative(basePath, join(dirPath, entry.name));
      const containerUrl = `${podUrl}${relativePath}/`;
      try {
        await fetch(containerUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'text/turtle',
            Authorization: authHeader,
          },
          body: '',
        });
      } catch {
        // Container may already exist
      }
      await restoreFromDir(join(dirPath, entry.name), podUrl, authHeader, basePath, stats);
    }
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      const filePath = join(dirPath, entry.name);
      const relativePath = relative(basePath, filePath);
      const resourceUrl = `${podUrl}${relativePath}`;
      const body = readFileSync(filePath);

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
          Authorization: authHeader,
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
      .option('email', { type: 'string', description: 'Account email (optional if credentials stored)' })
      .option('password', { type: 'string', description: 'Account password (optional if credentials stored)' })
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL',
      })
      .option('output', {
        alias: 'o',
        type: 'string',
        demandOption: true,
        description: 'Output directory path',
      }),
  handler: async (argv) => {
    const { authHeader, podUrl } = await resolveBackupAuth(argv);

    console.log(`Backing up pod: ${podUrl}`);
    console.log(`Output: ${argv.output}\n`);

    mkdirSync(argv.output, { recursive: true });
    const stats = { resources: 0, bytes: 0 };

    await crawlAndSave(podUrl, authHeader, podUrl, argv.output, stats);

    console.log(`\nBackup complete: ${stats.resources} resources, ${(stats.bytes / 1024).toFixed(1)} KB`);
  },
};

const restoreCommand: CommandModule<object, BackupImportArgs> = {
  command: 'restore',
  describe: 'Restore a Pod from a local backup directory',
  builder: (yargs) =>
    yargs
      .option('email', { type: 'string', description: 'Account email (optional if credentials stored)' })
      .option('password', { type: 'string', description: 'Account password (optional if credentials stored)' })
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL',
      })
      .option('input', {
        alias: 'i',
        type: 'string',
        demandOption: true,
        description: 'Input directory path',
      }),
  handler: async (argv) => {
    if (!existsSync(argv.input) || !statSync(argv.input).isDirectory()) {
      console.error(`Input path is not a directory: ${argv.input}`);
      process.exit(1);
    }

    const { authHeader, podUrl } = await resolveBackupAuth(argv);

    console.log(`Restoring to pod: ${podUrl}`);
    console.log(`Input: ${argv.input}\n`);

    const stats = { resources: 0, bytes: 0 };
    await restoreFromDir(argv.input, podUrl, authHeader, argv.input, stats);

    console.log(`\nRestore complete: ${stats.resources} resources, ${(stats.bytes / 1024).toFixed(1)} KB`);
  },
};

export { backupCommand, restoreCommand };
