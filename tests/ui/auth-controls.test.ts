import { describe, expect, it } from 'vitest';
import { normalizeAccountControls, normalizeAccountControlUrl } from '../../ui/src/context/AuthContext';

describe('auth control URL normalization', () => {
  it('rewrites loopback account controls to the current browser origin', () => {
    expect(normalizeAccountControlUrl(
      'http://localhost:5739/.account/login/password/?next=pod#form',
      'http://localhost:3000',
    )).toBe('http://localhost:3000/.account/login/password/?next=pod#form');

    expect(normalizeAccountControlUrl(
      'http://127.0.0.1:5739/.account/account/',
      'http://localhost:3000',
    )).toBe('http://localhost:3000/.account/account/');
  });

  it('does not rewrite external providers or non-account paths', () => {
    expect(normalizeAccountControlUrl(
      'https://id.example.com/.account/login/password/',
      'http://localhost:3000',
    )).toBe('https://id.example.com/.account/login/password/');

    expect(normalizeAccountControlUrl(
      'http://localhost:5739/cuilinsu/profile/card#me',
      'http://localhost:3000',
    )).toBe('http://localhost:5739/cuilinsu/profile/card#me');
  });

  it('normalizes nested control URLs used by the account UI', () => {
    const controls = normalizeAccountControls({
      password: {
        login: 'http://localhost:5739/.account/login/password/',
        forgot: 'http://localhost:5739/.account/login/password/forgot/',
      },
      account: {
        create: 'http://localhost:5739/.account/account/',
        logout: 'http://localhost:5739/.account/logout/',
        pod: 'http://localhost:5739/.account/account/pod/',
      },
      html: {
        password: {
          login: 'http://localhost:5739/.account/login/password/',
        },
      },
      oidc: {
        cancel: 'http://localhost:5739/.account/oidc/cancel/',
      },
      main: {
        logins: 'http://localhost:5739/.account/login/',
      },
    }, 'http://localhost:3000');

    expect(controls.password?.login).toBe('http://localhost:3000/.account/login/password/');
    expect(controls.password?.forgot).toBe('http://localhost:3000/.account/login/password/forgot/');
    expect(controls.account?.create).toBe('http://localhost:3000/.account/account/');
    expect(controls.account?.logout).toBe('http://localhost:3000/.account/logout/');
    expect(controls.account?.pod).toBe('http://localhost:3000/.account/account/pod/');
    expect(controls.html?.password?.login).toBe('http://localhost:3000/.account/login/password/');
    expect(controls.oidc?.cancel).toBe('http://localhost:3000/.account/oidc/cancel/');
    expect(controls.main?.logins).toBe('http://localhost:3000/.account/login/');
  });
});
