import { describe, expect, it } from 'bun:test';
import { trayIconAssetName } from '../src/tray-icon';

describe('trayIconAssetName', () => {
  it('maps every aggregate state to a distinct macOS template asset', () => {
    expect(new Set([
      trayIconAssetName('healthy', false),
      trayIconAssetName('starting', false),
      trayIconAssetName('degraded', false),
      trayIconAssetName('failed', false),
      trayIconAssetName('stopped', false),
    ]).size).toBe(5);
  });

  it('selects retina assets at 2x scale', () => {
    expect(trayIconAssetName('failed', true)).toBe('tray-failedTemplate@2x.png');
    expect(trayIconAssetName('healthy', false)).toBe('tray-healthyTemplate.png');
  });
});
