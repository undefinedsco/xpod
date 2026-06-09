import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { getLoggerFor } from 'global-logger-factory';
import { quadToRow } from '../storage/quint/serialization';
import { getSqliteRuntime, type SqliteDatabase } from '../storage/SqliteRuntime';
import type { AuthMode } from '../authorization/AuthMode';
import { buildPodAuthorizationResources } from '../authorization/PodAuthorizationResources';
import { RdfQuadIndex } from '../storage/rdf/RdfQuadIndex';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const LDP = 'http://www.w3.org/ns/ldp#';
const DCT = 'http://purl.org/dc/terms/';
const MA = 'http://www.w3.org/ns/ma-ont#';
const PIM = 'http://www.w3.org/ns/pim/space#';
const FOAF = 'http://xmlns.com/foaf/0.1/';
const SOLID = 'http://www.w3.org/ns/solid/terms#';

const { literal, namedNode, quad } = DataFactory;

export interface LocalPodProvisioningInput {
  podName: string;
  webId?: string;
  initialResources?: Record<string, string>;
}

export interface LocalPodProvisioningResult {
  podUrl: string;
  accountId: string;
  podId: string;
}

export interface LocalPodProvisioningServiceOptions {
  baseUrl: string;
  rootDir: string;
  sparqlEndpoint: string;
  identityDbUrl: string;
  rdfIndexPath?: string;
  oidcIssuer?: string;
  authMode?: AuthMode | string;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function stripSqlitePrefix(value: string, label: string): string {
  if (value.startsWith('sqlite:')) {
    return value.slice('sqlite:'.length);
  }
  if (value === ':memory:') {
    return value;
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw new Error(`${label} must be a sqlite URL for local Pod provisioning: ${value}`);
  }
  return value;
}

function stableUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function buildWebIdFromIssuer(oidcIssuer: string | undefined, podName: string): string | undefined {
  if (!oidcIssuer) {
    return undefined;
  }
  return new URL(`${encodeURIComponent(podName)}/profile/card#me`, ensureTrailingSlash(oidcIssuer)).toString();
}

function createQuintsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quints (
      graph TEXT NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      vector TEXT,
      PRIMARY KEY (graph, subject, predicate, object)
    );

    CREATE INDEX IF NOT EXISTS idx_spog ON quints (subject, predicate, object, graph);
    CREATE INDEX IF NOT EXISTS idx_ogsp ON quints (object, graph, subject, predicate);
    CREATE INDEX IF NOT EXISTS idx_gspo ON quints (graph, subject, predicate, object);
    CREATE INDEX IF NOT EXISTS idx_sopg ON quints (subject, object, predicate, graph);
    CREATE INDEX IF NOT EXISTS idx_pogs ON quints (predicate, object, graph, subject);
    CREATE INDEX IF NOT EXISTS idx_gpos ON quints (graph, predicate, object, subject);
  `);
}

function createInternalKvTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS internal_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function meta(resource: string): string {
  return `meta:${resource}`;
}

function iri(base: string, relative: string): string {
  return new URL(relative, base).toString();
}

export class LocalPodProvisioningService {
  private readonly logger = getLoggerFor(this);
  private readonly baseUrl: string;
  private readonly rootDir: string;
  private readonly sparqlDbPath: string;
  private readonly identityDbPath: string;
  private readonly rdfIndexPath?: string;
  private readonly oidcIssuer?: string;
  private readonly authMode?: AuthMode | string;
  private readonly sqliteRuntime = getSqliteRuntime();

  public constructor(options: LocalPodProvisioningServiceOptions) {
    this.baseUrl = ensureTrailingSlash(options.baseUrl);
    this.rootDir = options.rootDir;
    this.sparqlDbPath = stripSqlitePrefix(options.sparqlEndpoint, 'sparqlEndpoint');
    this.identityDbPath = stripSqlitePrefix(options.identityDbUrl, 'identityDbUrl');
    this.rdfIndexPath = options.rdfIndexPath;
    this.oidcIssuer = options.oidcIssuer ? ensureTrailingSlash(options.oidcIssuer) : undefined;
    this.authMode = options.authMode;
  }

  public async createPod(input: LocalPodProvisioningInput): Promise<LocalPodProvisioningResult> {
    const podUrl = ensureTrailingSlash(new URL(`${encodeURIComponent(input.podName)}/`, this.baseUrl).toString());
    const webId = input.webId ?? buildWebIdFromIssuer(this.oidcIssuer, input.podName) ?? `${podUrl}profile/card#me`;
    // Local stores the Pod, but the owner WebID trusts the actual token issuer.
    const oidcIssuer = this.oidcIssuer ?? this.baseUrl;
    const accountId = stableUuid(`account:${podUrl}:${webId}`);
    const podId = stableUuid(`pod:${podUrl}:${webId}`);
    const ownerId = stableUuid(`owner:${podId}:${webId}`);
    const webIdLinkId = stableUuid(`webIdLink:${accountId}:${webId}`);

    await this.createPodFiles(input.podName, input.initialResources);
    const quads = this.buildPodQuads({ podUrl, webId, oidcIssuer });
    this.writeQuints(quads);
    this.writeRdfIndex(quads);
    this.writeIdentityIndexes({ accountId, podId, ownerId, webIdLinkId, podUrl, webId });

    this.logger.info(`Provisioned local pod ${podUrl} for ${webId}`);
    return { podUrl, accountId, podId };
  }

  private async createPodFiles(podName: string, initialResources?: Record<string, string>): Promise<void> {
    const podPath = path.join(this.rootDir, podName);
    await fs.mkdir(path.join(podPath, 'profile'), { recursive: true });

    if (!initialResources) {
      return;
    }

    for (const [filename, content] of Object.entries(initialResources)) {
      const normalized = path.normalize(filename);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
        throw new Error(`Invalid initial resource path: ${filename}`);
      }
      const filePath = path.join(podPath, normalized);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');
    }
  }

  private writeQuints(quads: Quad[]): void {
    const db = this.sqliteRuntime.openDatabase(this.sparqlDbPath);
    try {
      createQuintsTable(db);
      const rows = quads.map((entry) => {
        const row = quadToRow(entry);
        return [row.graph, row.subject, row.predicate, row.object, row.vector] as const;
      });
      const insert = db.prepare(`
        INSERT OR IGNORE INTO quints (graph, subject, predicate, object, vector)
        VALUES (?, ?, ?, ?, ?)
      `);

      db.transaction(() => {
        for (const row of rows) {
          insert.run(...row);
        }
      })();
    } finally {
      db.close();
    }
  }

  private writeRdfIndex(quads: Quad[]): void {
    if (!this.rdfIndexPath) {
      return;
    }

    const index = new RdfQuadIndex({ path: this.rdfIndexPath });
    try {
      index.open();
      index.multiPut(quads);
    } finally {
      index.close();
    }
  }

  private buildPodQuads({ podUrl, webId, oidcIssuer }: { podUrl: string; webId: string; oidcIssuer: string }): Quad[] {
    const now = new Date().toISOString();
    const root = this.baseUrl;
    const profileUrl = iri(podUrl, 'profile/');
    const cardUrl = iri(podUrl, 'profile/card');
    const authorizationResources = buildPodAuthorizationResources({
      authMode: this.authMode,
      podUrl,
      cardUrl,
      webId,
      stableId: stableUuid,
      iri,
    });
    const rootGraph = namedNode(root);
    const podGraph = namedNode(podUrl);
    const profileGraph = namedNode(profileUrl);
    const cardGraph = namedNode(cardUrl);
    const out: Quad[] = [];

    const add = (graph: string, subject: string, predicate: string, object: string): void => {
      out.push(quad(namedNode(subject), namedNode(predicate), namedNode(object), namedNode(graph)));
    };
    const addLiteral = (graph: string, subject: string, predicate: string, value: string): void => {
      out.push(quad(namedNode(subject), namedNode(predicate), literal(value), namedNode(graph)));
    };
    const addDate = (graph: string, subject: string): void => {
      out.push(quad(namedNode(subject), namedNode(`${DCT}modified`), literal(now, namedNode('http://www.w3.org/2001/XMLSchema#dateTime')), namedNode(graph)));
    };
    const addContainerMeta = (resource: string, storage = false): void => {
      const graph = meta(resource);
      addDate(graph, resource);
      add(graph, resource, `${RDF}type`, `${LDP}Resource`);
      add(graph, resource, `${RDF}type`, `${LDP}Container`);
      add(graph, resource, `${RDF}type`, `${LDP}BasicContainer`);
      if (storage) {
        add(graph, resource, `${RDF}type`, `${PIM}Storage`);
      }
      addLiteral(graph, resource, `${MA}format`, 'internal/quads');
    };
    const addDocumentMeta = (resource: string): void => {
      const graph = meta(resource);
      addDate(graph, resource);
      add(graph, resource, `${RDF}type`, `${LDP}Resource`);
    };

    out.push(quad(namedNode(root), namedNode(`${LDP}contains`), namedNode(podUrl), rootGraph));
    out.push(quad(namedNode(podUrl), namedNode(`${LDP}contains`), namedNode(authorizationResources.rootResourceUrl), podGraph));
    out.push(quad(namedNode(podUrl), namedNode(`${LDP}contains`), namedNode(profileUrl), podGraph));
    out.push(quad(namedNode(profileUrl), namedNode(`${LDP}contains`), namedNode(authorizationResources.profileResourceUrl), profileGraph));
    out.push(quad(namedNode(profileUrl), namedNode(`${LDP}contains`), namedNode(cardUrl), profileGraph));
    out.push(quad(namedNode(profileUrl), namedNode(`${LDP}contains`), namedNode(authorizationResources.cardResourceUrl), profileGraph));

    addContainerMeta(root);
    addContainerMeta(podUrl, true);
    addContainerMeta(profileUrl);
    addDocumentMeta(authorizationResources.rootResourceUrl);
    addDocumentMeta(authorizationResources.profileResourceUrl);
    addDocumentMeta(cardUrl);
    addDocumentMeta(authorizationResources.cardResourceUrl);

    out.push(quad(namedNode(cardUrl), namedNode(`${RDF}type`), namedNode(`${FOAF}PersonalProfileDocument`), cardGraph));
    out.push(quad(namedNode(cardUrl), namedNode(`${FOAF}maker`), namedNode(webId), cardGraph));
    out.push(quad(namedNode(cardUrl), namedNode(`${FOAF}primaryTopic`), namedNode(webId), cardGraph));
    out.push(quad(namedNode(webId), namedNode(`${RDF}type`), namedNode(`${FOAF}Person`), cardGraph));
    out.push(quad(namedNode(webId), namedNode(`${SOLID}oidcIssuer`), namedNode(oidcIssuer), cardGraph));
    out.push(quad(namedNode(webId), namedNode(`${SOLID}storage`), namedNode(podUrl), cardGraph));

    out.push(...authorizationResources.quads);

    return out;
  }

  private writeIdentityIndexes(input: {
    accountId: string;
    podId: string;
    ownerId: string;
    webIdLinkId: string;
    podUrl: string;
    webId: string;
  }): void {
    const db = this.sqliteRuntime.openDatabase(this.identityDbPath);
    try {
      createInternalKvTable(db);
      const account = {
        linkedLoginsCount: 1,
        id: input.accountId,
        '**pod**': {
          [input.podId]: {
            baseUrl: input.podUrl,
            accountId: input.accountId,
            id: input.podId,
            '**owner**': {
              [input.ownerId]: {
                podId: input.podId,
                webId: input.webId,
                visible: false,
                id: input.ownerId,
              },
            },
          },
        },
        '**webIdLink**': {
          [input.webIdLinkId]: {
            webId: input.webId,
            accountId: input.accountId,
            id: input.webIdLinkId,
          },
        },
      };

      const rows: Array<[string, string]> = [
        [`accounts/data/${input.accountId}`, JSON.stringify(account)],
        [`accounts/index/pod/${input.podId}`, JSON.stringify([input.accountId])],
        [`accounts/index/pod/baseUrl/${encodeURIComponent(input.podUrl)}`, JSON.stringify([input.accountId])],
        [`accounts/index/owner/${input.ownerId}`, JSON.stringify([input.accountId])],
        [`accounts/index/webIdLink/${input.webIdLinkId}`, JSON.stringify([input.accountId])],
        [`accounts/index/webIdLink/webId/${encodeURIComponent(input.webId)}`, JSON.stringify([input.accountId])],
      ];
      const insert = db.prepare(`
        INSERT INTO internal_kv (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
      `);

      db.transaction(() => {
        for (const row of rows) {
          insert.run(...row);
        }
      })();
    } finally {
      db.close();
    }
  }
}
