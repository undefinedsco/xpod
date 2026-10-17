import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { afsConsumerBudget } from '../../scripts/lib/afs-consumer-budget';

describe('fixed AFS consumer deadlines', () => {
  it('projects the same cumulative bound in Python and TypeScript', () => {
    const code = `import importlib.util,json
s=importlib.util.spec_from_file_location('b','scripts/lib/afs-consumer-budget.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.projection()))`;
    const actual = JSON.parse(execFileSync('python3', [ '-c', code ], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }));
    expect(actual).toEqual(afsConsumerBudget());
    expect(actual.fullMountedCommandSeconds).toBeGreaterThan(3600);
    expect(actual.hostJobMinutes).toBeLessThan(360);
    expect(afsConsumerBudget('postpublish').maximumDurationSeconds - actual.maximumDurationSeconds).toBe(210);
    expect(actual.uploadWindowSeconds).toBe(600);
    expect(actual.officialRuntimeObservationSeconds).toBe(30);
    expect(actual.maximumDurationSeconds - actual.consumerRunSeconds).toBe(actual.safeExportSeconds + actual.commandOwnedCloseSeconds + actual.officialRuntimeObservationSeconds + actual.verifierRegistryObservationSeconds);
    expect(afsConsumerBudget('postpublish').hostJobMinutes).toBe(311);
  });
  it('extends only the two full profiles and preserves default runner bounds', () => {
    const code = `import importlib.util,json
s=importlib.util.spec_from_file_location('a','scripts/lib/afs-module-consumer.py')
a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
r=a.Runner.__new__(a.Runner);r.plan={'timeoutSeconds':30}
base=a.lifecycle.ModuleConsumerRunner.__new__(a.lifecycle.ModuleConsumerRunner);base.plan=r.plan
print(json.dumps([r.command_timeout_seconds(x) for x in ['node-afs-full-mounted-profile','bun-afs-full-mounted-profile','node-normal-cli-install','node-afs-full-mounted-profile-extra']]+[base.total_deadline_seconds(),base.command_timeout_seconds('node-afs-full-mounted-profile')]))`;
    expect(JSON.parse(execFileSync('python3', [ '-c', code ], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }))).toEqual([ 3660, 3660, 180, 30, 480, 30 ]);
  });
});
