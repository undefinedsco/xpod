import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { SqliteQuintStore } from '../src/storage/quint';
import {
  RdfQuadIndex,
  ShadowRdfQuintStore,
  SolidRdfEngine,
  defaultSyntheticMessagesForRdfModelsScale,
  runRdfModelsBenchmark,
  runRdfModelsShadowBenchmark,
  rdfModelsBenchmarkScaleSatisfied,
  rdfModelsBenchmarkSyntheticPodCount,
  rdfModelsBenchmarkScaleTargetQuads,
  type RdfBenchmarkScale,
} from '../src/storage/rdf';

const { namedNode, literal, quad } = DataFactory;

const POD = 'https://pod.example/alice';
const DATA = `${POD}/.data`;
const SETTINGS = `${POD}/settings`;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DCT_CREATED = 'http://purl.org/dc/terms/created';
const DCT_MODIFIED = 'http://purl.org/dc/terms/modified';
const DCT_TITLE = 'http://purl.org/dc/terms/title';
const SIOC_CONTENT = 'http://rdfs.org/sioc/ns#content';
const SIOC_HAS_MEMBER = 'http://rdfs.org/sioc/ns#has_member';
const SIOC = 'http://rdfs.org/sioc/ns#';
const MEETING = 'http://www.w3.org/ns/pim/meeting#';
const UDFS = 'https://undefineds.co/ns#';
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent';
const VCARD_INDIVIDUAL = 'http://www.w3.org/2006/vcard/ns#Individual';
const SCHEMA_CREATIVE_WORK = 'http://schema.org/CreativeWork';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

interface CliOptions {
  outDir: string;
  scale: RdfBenchmarkScale;
  iterations: number;
  syntheticMessages: number;
  syntheticMessagesOverridden: boolean;
  syntheticPodCount: number;
}

interface BenchmarkPaths {
  compatibilityDb: string;
  indexDb: string;
  baselineReport: string;
  shadowReport: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });

  const paths = createBenchmarkPaths(options.outDir);
  const compatibilityStore = new SqliteQuintStore({ path: paths.compatibilityDb });
  const shadowStore = new ShadowRdfQuintStore({
    compatibilityStore,
    index: new RdfQuadIndex({ path: paths.indexDb }),
  });

  try {
    await shadowStore.open();

    const seedQuads = buildSeedQuads(options);
    await compatibilityStore.multiPut(seedQuads);
    const backfill = await shadowStore.backfillShadowIndex({
      clear: true,
      batchSize: 1000,
    });

    const engine = new SolidRdfEngine({ index: shadowStore.index });
    const baseline = runRdfModelsBenchmark(engine, {
      scale: options.scale,
      iterations: options.iterations,
    });
    const shadow = await runRdfModelsShadowBenchmark(engine, compatibilityStore, {
      scale: options.scale,
      iterations: options.iterations,
    });

    await writeJson(paths.baselineReport, {
      seed: seedSummary(options, seedQuads.length, backfill),
      report: baseline,
    });
    await writeJson(paths.shadowReport, {
      seed: seedSummary(options, seedQuads.length, backfill),
      report: shadow,
    });

    printSummary({
      options,
      paths,
      seedQuadCount: seedQuads.length,
      targetQuadCount: rdfModelsBenchmarkScaleTargetQuads(options.scale),
      fullScale: rdfModelsBenchmarkScaleSatisfied(options.scale, seedQuads.length),
      syntheticPodCount: options.syntheticPodCount,
      backfilledRows: backfill.indexedRows,
      baselineCases: baseline.cases.length,
      localQueryCases: baseline.localQueryCases.length,
      shadowCases: shadow.cases.length,
      matched: shadow.matched,
      orderedMatched: shadow.orderedMatched,
      baselinePlanMatched: baseline.planMatched,
      shadowPlanMatched: shadow.planMatched,
      shadowSpaceGateEnforced: shadow.spaceGateEnforced,
      shadowPerformanceMatched: shadow.performanceMatched,
      shadowSpaceMatched: shadow.spaceMatched,
      failedPlanCases: [...new Set([
        ...baseline.failedPlanCases,
        ...shadow.failedPlanCases,
      ])],
      failedPerformanceCases: shadow.failedPerformanceCases,
      failedSpaceCases: shadow.failedSpaceCases,
      failedCases: shadow.cases
        .filter((testCase) => !testCase.matched || !testCase.orderedMatch)
        .map((testCase) => testCase.name),
    });

    if (
      !shadow.matched
      || !shadow.orderedMatched
      || !baseline.planMatched
      || !shadow.planMatched
      || !shadow.performanceMatched
      || !shadow.spaceMatched
      || !rdfModelsBenchmarkScaleSatisfied(options.scale, seedQuads.length)
    ) {
      process.exitCode = 1;
    }
  } finally {
    await shadowStore.close();
  }
}

function parseArgs(args: string[]): CliOptions {
  let outDir = path.join(process.cwd(), '.test-data', 'rdf-engine');
  let scale: RdfBenchmarkScale = 'medium';
  let iterations = 3;
  let syntheticMessages: number | undefined;

  for (const arg of args) {
    if (arg.startsWith('--out=')) {
      outDir = path.resolve(arg.slice('--out='.length));
      continue;
    }
    if (arg.startsWith('--scale=')) {
      const value = arg.slice('--scale='.length);
      if (value !== 'small' && value !== 'medium' && value !== 'large') {
        throw new Error(`Unsupported --scale value: ${value}`);
      }
      scale = value;
      continue;
    }
    if (arg.startsWith('--iterations=')) {
      iterations = positiveInteger(arg.slice('--iterations='.length), '--iterations');
      continue;
    }
    if (arg.startsWith('--syntheticMessages=')) {
      syntheticMessages = positiveInteger(arg.slice('--syntheticMessages='.length), '--syntheticMessages');
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    outDir,
    scale,
    iterations,
    syntheticMessages: syntheticMessages ?? defaultSyntheticMessagesForRdfModelsScale(scale),
    syntheticMessagesOverridden: syntheticMessages !== undefined,
    syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount(scale),
  };
}

function positiveInteger(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function createBenchmarkPaths(outDir: string): BenchmarkPaths {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${stamp}-${process.pid}-${randomUUID()}`;
  return {
    compatibilityDb: path.join(outDir, `rdf-models-compat-${runId}.sqlite`),
    indexDb: path.join(outDir, `rdf-models-index-${runId}.sqlite`),
    baselineReport: path.join(outDir, `models-baseline-${runId}.json`),
    shadowReport: path.join(outDir, `models-shadow-${runId}.json`),
  };
}

function buildSeedQuads(options: CliOptions): Quad[] {
  const quads: Quad[] = [];

  seedChatTaskThreadRunProviderQuads(quads);
  seedAgentContactFavoriteQuads(quads);
  seedCanonicalMessages(quads);
  seedSyntheticMessages(quads, options.syntheticMessages, options.syntheticPodCount);

  return quads;
}

function seedChatTaskThreadRunProviderQuads(quads: Quad[]): void {
  const chatGraph = `${DATA}/chat/default/index.ttl`;
  const chat = `${chatGraph}#this`;
  const thread = `${chatGraph}#thread_1`;
  const taskGraph = `${DATA}/task/index.ttl`;
  const task = `${taskGraph}#default`;
  const taskThreadGraph = `${DATA}/task/default/index.ttl`;
  const taskThread = `${taskThreadGraph}#thread_1`;
  const scheduleGraph = `${DATA}/task/default/2026/05/18/schedules.ttl`;
  const runGraph = `${DATA}/task/default/2026/05/18/runs.ttl`;
  const run = `${runGraph}#run_1`;
  const workspace = 'file://macbook.local/Users/alice/project/';
  const provider = `${SETTINGS}/providers/anthropic.ttl`;
  const credentialGraph = `${SETTINGS}/credentials.ttl`;
  const credential = `${credentialGraph}#anthropic-default`;

  quads.push(
    q(chat, RDF_TYPE, iri(`${MEETING}LongChat`), chatGraph),
    q(chat, DCT_TITLE, literal('Default chat'), chatGraph),
    q(chat, DCT_MODIFIED, literal('2026-05-18T00:00:00.000Z'), chatGraph),
    q(thread, RDF_TYPE, iri(`${SIOC}Thread`), chatGraph),
    q(thread, DCT_CREATED, literal('2026-05-18T00:00:01.000Z'), chatGraph),
    q(thread, `${UDFS}workspace`, iri(workspace), chatGraph),
    q(task, RDF_TYPE, iri(`${UDFS}Task`), taskGraph),
    q(task, `${UDFS}status`, literal('active'), taskGraph),
    q(task, `${UDFS}workspace`, iri(workspace), taskGraph),
    q(taskThread, RDF_TYPE, iri(`${SIOC}Thread`), taskThreadGraph),
    q(taskThread, DCT_CREATED, literal('2026-05-18T00:30:00.000Z'), taskThreadGraph),
    q(`${scheduleGraph}#schedule_1`, RDF_TYPE, iri(`${UDFS}Schedule`), scheduleGraph),
    q(`${scheduleGraph}#schedule_1`, `${UDFS}status`, literal('active'), scheduleGraph),
    q(`${scheduleGraph}#schedule_1`, `${UDFS}nextRunAt`, literal('2026-05-18T01:00:00.000Z'), scheduleGraph),
    q(run, RDF_TYPE, iri(`${UDFS}Run`), runGraph),
    q(run, DCT_CREATED, literal('2026-05-18T01:00:00.000Z'), runGraph),
    q(run, `${UDFS}status`, literal('queued'), runGraph),
    q(run, `${UDFS}workspace`, iri(workspace), runGraph),
    q(run, `${UDFS}priority`, literal('10', iri(XSD_INTEGER)), runGraph),
    q(`${runGraph}#run_2`, RDF_TYPE, iri(`${UDFS}Run`), runGraph),
    q(`${runGraph}#run_2`, DCT_CREATED, literal('2026-05-18T01:05:00.000Z'), runGraph),
    q(`${runGraph}#run_2`, `${UDFS}status`, literal('queued'), runGraph),
    q(`${runGraph}#run_2`, `${UDFS}workspace`, iri(workspace), runGraph),
    q(`${runGraph}#run_2`, `${UDFS}priority`, literal('2', iri(XSD_INTEGER)), runGraph),
    q(`${runGraph}#run_3`, RDF_TYPE, iri(`${UDFS}Run`), runGraph),
    q(`${runGraph}#run_3`, DCT_CREATED, literal('2026-05-18T01:10:00.000Z'), runGraph),
    q(`${runGraph}#run_3`, `${UDFS}status`, literal('running'), runGraph),
    q(`${runGraph}#run_3`, `${UDFS}workspace`, iri(workspace), runGraph),
    q(`${runGraph}#run_3`, `${UDFS}priority`, literal('8', iri(XSD_INTEGER)), runGraph),
    q(`${runGraph}#step_1`, RDF_TYPE, iri(`${UDFS}RunStep`), runGraph),
    q(`${runGraph}#step_1`, `${UDFS}run`, iri(run), runGraph),
    q(`${runGraph}#step_2`, RDF_TYPE, iri(`${UDFS}RunStep`), runGraph),
    q(`${runGraph}#step_2`, `${UDFS}run`, iri(run), runGraph),
    q(provider, RDF_TYPE, iri(`${UDFS}Provider`), provider),
    q(provider, `${UDFS}displayName`, literal('Anthropic'), provider),
    q(`${provider}#claude-sonnet-4`, RDF_TYPE, iri(`${UDFS}Model`), provider),
    q(`${provider}#claude-sonnet-4`, `${UDFS}isProvidedBy`, iri(provider), provider),
    q(credential, RDF_TYPE, iri(`${UDFS}Credential`), credentialGraph),
    q(credential, `${UDFS}provider`, iri(provider), credentialGraph),
  );
}

function seedAgentContactFavoriteQuads(quads: Quad[]): void {
  const agentGraph = `${DATA}/agents/secretary.ttl`;
  const agent = `${agentGraph}#this`;
  const contactGraph = `${DATA}/contacts/secretary.ttl`;
  const contact = contactGraph;
  const favoriteGraph = `${DATA}/favorites/2026/05/18.ttl`;
  const favorite = `${favoriteGraph}#favorite_1`;
  const chat = `${DATA}/chat/default/index.ttl#this`;

  quads.push(
    q(agent, RDF_TYPE, iri(FOAF_AGENT), agentGraph),
    q(agent, `${UDFS}provider`, literal('anthropic'), agentGraph),
    q(agent, `${UDFS}model`, literal('claude-sonnet-4'), agentGraph),
    q(contact, RDF_TYPE, iri(VCARD_INDIVIDUAL), contactGraph),
    q(contact, `${UDFS}contactType`, literal('agent'), contactGraph),
    q(contact, `${UDFS}favorite`, literal('true'), contactGraph),
    q(favorite, RDF_TYPE, iri(SCHEMA_CREATIVE_WORK), favoriteGraph),
    q(favorite, `${UDFS}favoriteTarget`, iri(chat), favoriteGraph),
    q(favorite, `${UDFS}favoredAt`, literal('2026-05-18T02:00:00.000Z'), favoriteGraph),
  );
}

function seedCanonicalMessages(quads: Quad[]): void {
  const thread = `${DATA}/chat/default/index.ttl#thread_1`;
  const graph = `${DATA}/chat/default/2026/05/18/messages.ttl`;

  for (let index = 0; index < 3; index += 1) {
    const message = `${graph}#msg_${index + 1}`;
    const timestamp = `2026-05-18T00:0${index + 1}:00.000Z`;
    quads.push(
      q(message, RDF_TYPE, iri(`${MEETING}Message`), graph),
      q(message, SIOC_HAS_MEMBER, iri(thread), graph),
      q(message, DCT_CREATED, literal(timestamp), graph),
      q(message, DCT_MODIFIED, literal(timestamp), graph),
      q(message, SIOC_CONTENT, literal(`canonical message ${index + 1}`), graph),
    );
  }

}

function seedSyntheticMessages(quads: Quad[], count: number, podCount: number): void {
  const syntheticPodCount = Math.max(1, Math.floor(podCount));
  for (let index = 0; index < count; index += 1) {
    const podIndex = index % syntheticPodCount;
    const pod = podIndex === 0 ? POD : `https://pod.example/synthetic-${podIndex}`;
    const data = `${pod}/.data`;
    const thread = `${data}/chat/default/index.ttl#thread_1`;
    const dayNumber = (index % 28) + 1;
    const day = String(dayNumber).padStart(2, '0');
    const graph = `${data}/chat/default/2026/05/${day}/messages.ttl`;
    const message = `${graph}#synthetic_${index}`;
    const timestamp = new Date(Date.UTC(2026, 4, dayNumber, 12, 0, index)).toISOString();
    quads.push(
      q(message, RDF_TYPE, iri(`${MEETING}Message`), graph),
      q(message, SIOC_HAS_MEMBER, iri(thread), graph),
      q(message, DCT_CREATED, literal(timestamp), graph),
      q(message, SIOC_CONTENT, literal(`synthetic searchable message ${index}`), graph),
    );
  }
}

function q(subject: string, predicate: string, object: ReturnType<typeof iri> | ReturnType<typeof literal>, graph: string): Quad {
  return quad(namedNode(subject), namedNode(predicate), object, namedNode(graph));
}

function iri(value: string): ReturnType<typeof namedNode> {
  return namedNode(value);
}

function seedSummary(
  options: CliOptions,
  seedQuadCount: number,
  backfill: { scannedRows: number; indexedRows: number; batchCount: number; durationMs: number },
): Record<string, unknown> {
  return {
    pod: POD,
    scale: options.scale,
    iterations: options.iterations,
    syntheticMessages: options.syntheticMessages,
    syntheticMessagesOverridden: options.syntheticMessagesOverridden,
    syntheticPodCount: options.syntheticPodCount,
    seedQuadCount,
    targetQuadCount: rdfModelsBenchmarkScaleTargetQuads(options.scale),
    fullScale: rdfModelsBenchmarkScaleSatisfied(options.scale, seedQuadCount),
    backfill,
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function printSummary(summary: {
  options: CliOptions;
  paths: BenchmarkPaths;
  seedQuadCount: number;
  targetQuadCount: number;
  fullScale: boolean;
  syntheticPodCount: number;
  backfilledRows: number;
  baselineCases: number;
  localQueryCases: number;
  shadowCases: number;
  matched: boolean;
  orderedMatched: boolean;
  baselinePlanMatched: boolean;
  shadowPlanMatched: boolean;
  shadowSpaceGateEnforced: boolean;
  shadowPerformanceMatched: boolean;
  shadowSpaceMatched: boolean;
  failedPlanCases: string[];
  failedPerformanceCases: string[];
  failedSpaceCases: string[];
  failedCases: string[];
}): void {
  console.log('RDF models benchmark complete');
  console.log(`  scale: ${summary.options.scale}`);
  console.log(`  iterations: ${summary.options.iterations}`);
  console.log(`  seed quads: ${summary.seedQuadCount}`);
  console.log(`  target quads: ${summary.targetQuadCount}`);
  console.log(`  full scale seed: ${summary.fullScale}`);
  console.log(`  synthetic pods: ${summary.syntheticPodCount}`);
  if (summary.options.syntheticMessagesOverridden && !summary.fullScale) {
    console.error('  syntheticMessages override is below the selected scale target');
  }
  console.log(`  backfilled rows: ${summary.backfilledRows}`);
  console.log(`  baseline cases: ${summary.baselineCases}`);
  console.log(`  local query cases: ${summary.localQueryCases}`);
  console.log(`  shadow cases: ${summary.shadowCases}`);
  console.log(`  shadow matched: ${summary.matched}`);
  console.log(`  shadow ordered matched: ${summary.orderedMatched}`);
  console.log(`  baseline plan matched: ${summary.baselinePlanMatched}`);
  console.log(`  shadow plan matched: ${summary.shadowPlanMatched}`);
  console.log(`  shadow performance matched: ${summary.shadowPerformanceMatched}`);
  console.log(`  shadow space matched: ${summary.shadowSpaceMatched}${summary.shadowSpaceGateEnforced ? '' : ' (not enforced for this scale)'}`);
  console.log(`  baseline report: ${summary.paths.baselineReport}`);
  console.log(`  shadow report: ${summary.paths.shadowReport}`);
  if (summary.failedPlanCases.length > 0) {
    console.error(`  failed plan cases: ${summary.failedPlanCases.join(', ')}`);
  }
  if (summary.failedCases.length > 0) {
    console.error(`  failed cases: ${summary.failedCases.join(', ')}`);
  }
  if (summary.failedPerformanceCases.length > 0) {
    console.error(`  failed performance cases: ${summary.failedPerformanceCases.join(', ')}`);
  }
  if (summary.failedSpaceCases.length > 0) {
    console.error(`  failed space cases: ${summary.failedSpaceCases.join(', ')}`);
  }
}

function printHelp(): void {
  console.log(`Usage: bun scripts/rdf-models-benchmark.ts [options]

Options:
  --scale=small|medium|large       Select benchmark case scale. Default: medium
  --iterations=N                   Iterations per case. Default: 3
  --syntheticMessages=N            Override generated message count for storage-size tests
  --out=PATH                       Output directory. Default: .test-data/rdf-engine
`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
