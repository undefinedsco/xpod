import { describe, expect, it } from 'bun:test';
import { trayIconAssetName, XPOD_TRAY_GUID } from '../src/tray-icon';

describe('trayIconAssetName', () => {
  it('maps every aggregate state to a distinct macOS template asset', () => {
    expect(new Set([
      trayIconAssetName('healthy'),
      trayIconAssetName('starting'),
      trayIconAssetName('degraded'),
      trayIconAssetName('failed'),
      trayIconAssetName('stopped'),
    ]).size).toBe(5);
  });

  it('always selects the base asset so Electron discovers both 1x and @2x representations', () => {
    expect(trayIconAssetName('failed')).toBe('tray-failedTemplate.png');
    expect(trayIconAssetName('healthy')).toBe('tray-healthyTemplate.png');
  });

  it('uses a stable GUID so macOS persists the user-selected menu-bar position', () => {
    expect(XPOD_TRAY_GUID).toBe('5e58d7b4-bf0d-4a0c-83a8-6bb48c2d7dc4');
  });
});
