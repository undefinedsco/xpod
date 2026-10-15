import { fileURLToPath } from 'node:url';

/** External producer fixtures must work from both repository and package cwd. */
export const apiTestRepoRoot = fileURLToPath(new URL('../../../', import.meta.url));
