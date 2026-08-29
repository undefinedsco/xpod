#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';

interface SeedPod {
  name?: unknown;
  [key: string]: unknown;
}

interface SeedAccount {
  email?: unknown;
  pods?: unknown;
  [key: string]: unknown;
}

export function materializeRcSeedConfig(input: unknown, suffixInput: string): SeedAccount[] {
  if (!Array.isArray(input)) {
    throw new Error('RC seed config must be an array');
  }

  const suffix = normalizeDnsLabel(suffixInput);
  if (!suffix) {
    throw new Error('RC seed suffix must contain at least one letter or number');
  }

  return input.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`RC seed account at index ${index} must be an object`);
    }

    const account = value as SeedAccount;
    if (typeof account.email !== 'string' || !account.email.includes('@')) {
      throw new Error(`RC seed account at index ${index} must include an email address`);
    }
    if (!Array.isArray(account.pods) || account.pods.length === 0) {
      throw new Error(`RC seed account at index ${index} must include at least one Pod`);
    }

    const at = account.email.lastIndexOf('@');
    const local = account.email.slice(0, at);
    const domain = account.email.slice(at + 1);
    if (!local || !domain) {
      throw new Error(`RC seed account at index ${index} must include a valid email address`);
    }
    const pods = account.pods.map((value, podIndex) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`RC seed Pod at account ${index}, index ${podIndex} must be an object`);
      }
      const pod = value as SeedPod;
      if (typeof pod.name !== 'string' || !pod.name.trim()) {
        throw new Error(`RC seed Pod at account ${index}, index ${podIndex} must include a name`);
      }
      return {
        ...pod,
        name: appendDnsSuffix(pod.name, suffix),
      };
    });

    return {
      ...account,
      email: `${local}-${suffix}@${domain}`,
      pods,
    };
  });
}

function appendDnsSuffix(name: string, suffix: string): string {
  const normalizedName = normalizeDnsLabel(name);
  if (!normalizedName) {
    throw new Error(`RC seed Pod name cannot be normalized: ${name}`);
  }
  const maxBaseLength = 63 - suffix.length - 1;
  if (maxBaseLength < 1) {
    throw new Error('RC seed suffix is too long for a Pod name');
  }
  const base = normalizedName.slice(0, maxBaseLength).replace(/-+$/g, '');
  return `${base}-${suffix}`;
}

function normalizeDnsLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function parseArgs(argv: string[]): { inputPath: string; outputPath: string; suffix: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('usage: materialize-rc-seed-config --input PATH --output PATH --suffix VALUE');
    }
    values.set(key, value);
  }
  const inputPath = values.get('--input');
  const outputPath = values.get('--output');
  const suffix = values.get('--suffix');
  if (!inputPath || !outputPath || !suffix) {
    throw new Error('usage: materialize-rc-seed-config --input PATH --output PATH --suffix VALUE');
  }
  return { inputPath, outputPath, suffix };
}

if (import.meta.main) {
  try {
    const { inputPath, outputPath, suffix } = parseArgs(process.argv.slice(2));
    const parsed = JSON.parse(await readFile(inputPath, 'utf8')) as unknown;
    const materialized = materializeRcSeedConfig(parsed, suffix);
    await writeFile(outputPath, `${JSON.stringify(materialized, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error(`[materialize-rc-seed-config] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
