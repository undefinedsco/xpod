/** Artifact naming only. Coordinates and JSON cannot issue native custody. */
export function candidateServiceNativeRuntimeArtifactName(input: {
  sourceSha: string; runId: number; runAttempt: number;
}): string {
  if (!/^[a-f0-9]{40}$/u.test(input.sourceSha)
    || !Number.isSafeInteger(input.runId) || input.runId < 1
    || !Number.isSafeInteger(input.runAttempt) || input.runAttempt < 1) {
    throw Error('Exact candidate native runtime artifact coordinates required');
  }
  return `candidate-service-native-runtime-linux-x64-${input.sourceSha}-${input.runId}-${input.runAttempt}`;
}
