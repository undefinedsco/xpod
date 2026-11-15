"""AFS-only projections of the single reviewed budget declaration.

Bounds are failure deadlines, not predicted running times. API/CSS keep their
existing limits. Each capture stage includes all roots in that stage.
"""
import json
from pathlib import Path

REGISTRY = json.loads(Path(__file__).with_name('registry-legal-original-limits.json').read_text())
LIMITS = json.loads(Path(__file__).with_name('module-artifact-limits.json').read_text())
BUDGET = json.loads((Path(__file__).with_suffix('.json')).read_text())
assert BUDGET['schemaVersion'] == 1 and BUDGET['kind'] == 'fixed-afs-consumer-budget'
assert all(type(v) is int and v > 0 for k, v in BUDGET.items() if k not in ('schemaVersion', 'kind', 'harnessCommands'))


def projection(stage='prepublish'):
    assert stage in ('prepublish', 'postpublish'), 'unknown AFS consumer stage'
    b = BUDGET
    full = b['mountedHarnessSeconds'] + b['mountedOwnedCloseSeconds'] + b['mountedSerializationSeconds']
    ordinary = b['runtimeCount'] * b['ordinaryCommandsPerRuntime'] + b['toolVersionCommands']
    commands = ordinary + 2 * b['runtimeCount'] + len(b['harnessCommands'])
    assert len({row['label'] for row in b['harnessCommands']}) == 6 and all(type(row['timeoutSeconds']) is int and row['timeoutSeconds'] > 0 for row in b['harnessCommands'])
    run = (ordinary * b['ordinaryCommandSeconds'] + b['runtimeCount'] * (full + b['normalInstallSeconds'])
           + commands * b['commandOwnedCloseSeconds'] + b['captureStages'] * b['captureStageSeconds']
           + b['sourceObservationCommands'] * b['sourceObservationCommandSeconds'] + b['runtimeCount'] * b['cycleCleanupSeconds'] + sum(row['timeoutSeconds'] for row in b['harnessCommands']))
    assert type(REGISTRY['groupTimeoutMs']) is int and REGISTRY['groupTimeoutMs'] > 0 and REGISTRY['groupTimeoutMs'] % 1000 == 0
    registry = REGISTRY['groupTimeoutMs'] // 1000
    maximum = run + registry + b['officialRuntimeObservationSeconds'] + b['safeExportSeconds'] + b['commandOwnedCloseSeconds']
    if stage == 'postpublish':
        maximum += b['registryReadbackSeconds'] + b['registrySingleflightSeconds']
    host = maximum + b['hostSetupSeconds'] + b['hostFinalizationSeconds'] + b['uploadWindowSeconds']
    assert host < 6 * 3600, 'AFS host projection exceeds six-hour authority'
    return dict(verifierRegistryObservationSeconds=registry, officialRuntimeObservationSeconds=b['officialRuntimeObservationSeconds'], freshHarnessLiveBytes=LIMITS['sourceBytes'] + 2 * LIMITS['dependencyBytes'], harnessCommands=b['harnessCommands'], safeExportSeconds=b['safeExportSeconds'], commandOwnedCloseSeconds=b['commandOwnedCloseSeconds'], stage=stage, hostSetupSeconds=b['hostSetupSeconds'], hostFinalizationSeconds=b['hostFinalizationSeconds'],
                uploadWindowSeconds=b['uploadWindowSeconds'], registryReadbackSeconds=b['registryReadbackSeconds'],
                registrySingleflightSeconds=b['registrySingleflightSeconds'], fullMountedCommandSeconds=full, normalInstallSeconds=b['normalInstallSeconds'], ordinaryCommandSeconds=b['ordinaryCommandSeconds'],
                consumerRunSeconds=run, maximumDurationSeconds=maximum,
                hostJobMinutes=(host + 59) // 60)
