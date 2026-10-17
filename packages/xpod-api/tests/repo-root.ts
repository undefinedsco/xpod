import { fileURLToPath } from 'node:url';

/** External producer fixtures must work from both repository and package cwd. */
export const apiTestRepoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Explicit cold compiler/stage/sourcekit integration cases only; fast fixtures keep runner defaults. */
export const API_BUILD_INTEGRATION_TIMEOUT_MS = 30_000;
