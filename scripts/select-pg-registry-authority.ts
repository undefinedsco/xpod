/**
 * Registry pull authority selection for the immutable PG17 images.
 *
 * The authority is a CREDENTIAL SOURCE, not a statement about which image the
 * RC workload will run. That distinction matters: the existing workflow already
 * proves a *candidate* PG image while the declared authority workload still
 * runs the older shared image, so binding the authority to the candidate would
 * be a false requirement.
 *
 * The contract is deliberately strict and generic:
 *   - the authority workload is a single-container StatefulSet/Deployment;
 *   - its image is one of the explicitly declared digests (current or target),
 *     never a wildcard, `latest`, or an unbound live value;
 *   - it declares exactly one valid imagePullSecret name;
 *   - that secret is reused as the sole pull credential.
 *
 * "Current" and "target" are supplied by the caller from the workflow's own
 * declared constants, so the guard cannot silently follow a live image.
 */

import { readFileSync } from 'node:fs';

export interface AuthorityWorkload {
  kind?: unknown;
  spec?: { template?: { spec?: {
    containers?: { image?: unknown; name?: unknown }[];
    imagePullSecrets?: { name?: unknown }[];
  } } };
}

const SECRET_NAME = /^[a-z0-9](?:[-a-z0-9]{0,251}[a-z0-9])?$/;
const IMMUTABLE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export interface AuthorityDeclarations {
  /** Digest currently declared by the shared production workload. */
  current: string;
  /** Digest this release intends to run for RC (and later production). */
  target: string;
}

function requireImmutable(label: string, value: string): string {
  if (typeof value !== 'string' || !IMMUTABLE.test(value)) {
    throw new Error(`${label} must be an immutable sha256 digest reference`);
  }
  return value;
}

export function parseAuthorityDeclarations(current: string, target: string): AuthorityDeclarations {
  const declarations = {
    current: requireImmutable('current-pg-image', current),
    target: requireImmutable('target-pg-image', target),
  };
  if (declarations.current === declarations.target) {
    // Not fatal by itself, but it hides which transition is being proven.
    throw new Error('current-pg-image and target-pg-image must be distinct');
  }
  return declarations;
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function cli(argv: string[]): void {
  const workloadPath = argValue(argv, '--pg-workload');
  const current = argValue(argv, '--current-image');
  const target = argValue(argv, '--target-image');
  if (!workloadPath || !current || !target) {
    throw new Error('usage: --pg-workload FILE --current-image REF --target-image REF');
  }
  const workload = JSON.parse(readFileSync(workloadPath, 'utf8')) as AuthorityWorkload;
  const declarations = parseAuthorityDeclarations(current, target);
  const result = selectPgRegistryAuthority(workload, declarations);
  process.stdout.write(`${result.secretName}\n`);
}

const invokedDirectly = process.argv[1]?.endsWith('select-pg-registry-authority.ts')
  || process.argv[1]?.endsWith('select-pg-registry-authority.js');
if (invokedDirectly) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[select-pg-registry-authority] ${(error as Error).message}\n`);
    process.exit(1);
  }
}

export function selectPgRegistryAuthority(
  workload: AuthorityWorkload,
  declarations: AuthorityDeclarations,
): { secretName: string; authorisedImage: string; role: 'current' | 'target' } {
  const current = requireImmutable('current-pg-image', declarations.current);
  const target = requireImmutable('target-pg-image', declarations.target);
  if (!('kind' in (workload ?? {}))) throw new Error('PG authority workload is missing kind');
  if (workload.kind !== 'StatefulSet' && workload.kind !== 'Deployment') {
    throw new Error('PG authority workload must be a StatefulSet or Deployment');
  }
  const spec = workload.spec?.template?.spec;
  const containers = spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) {
    throw new Error('PG authority workload must declare exactly one container');
  }
  const image = containers[0]?.image;
  if (typeof image !== 'string' || !IMMUTABLE.test(image)) {
    throw new Error('PG authority workload image must be an immutable digest reference');
  }
  // Strict membership in the caller-declared pair: no wildcard, no live image,
  // no `latest`, no prefix match.
  if (image !== current && image !== target) {
    throw new Error('PG authority workload image is not one of the declared current/target digests');
  }
  const secrets = spec?.imagePullSecrets;
  if (!Array.isArray(secrets) || secrets.length !== 1
    || typeof secrets[0]?.name !== 'string' || !SECRET_NAME.test(secrets[0].name)) {
    throw new Error('PG authority workload must declare exactly one valid imagePullSecret');
  }
  return {
    secretName: secrets[0].name,
    authorisedImage: image,
    role: image === current ? 'current' : 'target',
  };
}
