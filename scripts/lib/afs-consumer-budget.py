"""AFS-only projections of the single reviewed budget declaration.

Bounds are failure deadlines, not predicted running times. API/CSS keep their
existing limits. Each capture stage includes all roots in that stage.
"""
import json
from pathlib import Path

BUDGET = json.loads((Path(__file__).with_suffix('.json')).read_text())
assert BUDGET['schemaVersion'] == 1 and BUDGET['kind'] == 'fixed-afs-consumer-budget'
assert all(type(v) is int and v > 0 for k, v in BUDGET.items() if k not in ('schemaVersion', 'kind'))


def projection(stage='prepublish'):
    assert stage in ('prepublish', 'postpublish'), 'unknown AFS consumer stage'
    b = BUDGET
    full = b['mountedHarnessSeconds'] + b['mountedOwnedCloseSeconds'] + b['mountedSerializationSeconds']
    ordinary = b['runtimeCount'] * b['ordinaryCommandsPerRuntime'] + b['toolVersionCommands']
    commands = ordinary + b['runtimeCount']
    run = (ordinary * b['ordinaryCommandSeconds'] + b['runtimeCount'] * full
           + commands * b['commandOwnedCloseSeconds'] + b['captureStages'] * b['captureStageSeconds']
           + b['runtimeCount'] * b['cycleCleanupSeconds'])
    maximum = run + b['safeExportSeconds'] + b['commandOwnedCloseSeconds']
    if stage == 'postpublish':
        maximum += b['registryReadbackSeconds'] + b['registrySingleflightSeconds']
    host = maximum + b['hostSetupSeconds'] + b['hostFinalizationSeconds'] + b['uploadWindowSeconds']
    assert host < 6 * 3600, 'AFS host projection exceeds six-hour authority'
    return dict(safeExportSeconds=b['safeExportSeconds'], commandOwnedCloseSeconds=b['commandOwnedCloseSeconds'], stage=stage, hostSetupSeconds=b['hostSetupSeconds'], hostFinalizationSeconds=b['hostFinalizationSeconds'],
                uploadWindowSeconds=b['uploadWindowSeconds'], registryReadbackSeconds=b['registryReadbackSeconds'],
                registrySingleflightSeconds=b['registrySingleflightSeconds'], fullMountedCommandSeconds=full, ordinaryCommandSeconds=b['ordinaryCommandSeconds'],
                consumerRunSeconds=run, maximumDurationSeconds=maximum,
                hostJobMinutes=(host + 59) // 60)
