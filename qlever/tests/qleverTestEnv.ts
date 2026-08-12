import path from 'node:path';

const requiredHostVariables = [
  'HOME',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
];

export function cleanQleverEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of requiredHostVariables) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return { ...env, ...overrides };
}

export function qleverNativeIncludeArgs(repoRoot: string, qleverSource: string): string[] {
  return [
    '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
    '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
    '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
    '-I', path.join(repoRoot, 'qlever/include'),
    '-I', path.join(qleverSource, 'src'),
  ];
}
