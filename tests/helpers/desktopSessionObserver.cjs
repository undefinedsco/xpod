const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Only allowlisted counters leave memory; request bodies/URLs are never persisted. */
function observeRequest(state, details, issuer) {
  const url = new URL(details.url);
  if (url.origin !== new URL(issuer).origin || details.method !== 'POST') return;
  if (/^\/\.account\/(?:interaction\/[^/]+\/)?login\/password\/?$/.test(url.pathname)) state.passwordPosts++;
  const uploads = details.uploadData ?? [];
  if (uploads.some(part => part.file || part.blobUUID || !Buffer.isBuffer(part.bytes))
    || uploads.reduce((sum, part) => sum + (part.bytes?.length ?? 0), 0) > 65536) {
    state.opaquePosts++;
    return;
  }
  const grant = new URLSearchParams(Buffer.concat(uploads.map(part => part.bytes)).toString()).get('grant_type');
  if (grant === 'authorization_code') state.authorizationCodes++;
  if (grant === 'refresh_token') state.refreshTokens++;
}

if (process.versions.electron) {
  const { app, session } = require('electron');
  const destination = process.env.XPOD_SESSION_OBSERVER_OUTPUT;
  const issuer = process.env.XPOD_SESSION_OBSERVER_ISSUER;
  const host = process.argv[2];
  if (!destination || !issuer || !host || !process.env.XPOD_DESKTOP_USER_DATA_DIR) throw new Error('Observer requires owned launch inputs');
  app.setPath('userData', path.resolve(process.env.XPOD_DESKTOP_USER_DATA_DIR));
  const state = { hostPid: process.pid, ready: false, hostImported: false, failed: false, authorizationCodes: 0, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0 };
  writeFileSync(destination, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  const save = () => writeFileSync(destination, JSON.stringify(state), { mode: 0o600 });
  const attached = new WeakSet();
  const attach = ses => {
    if (attached.has(ses)) return;
    attached.add(ses);
    ses.webRequest.onBeforeRequest((details, callback) => {
      try { observeRequest(state, details, issuer); } catch { state.failed = true; }
      finally {
        callback({}); // Never rewrite/block the real request or its response.
        try { save(); } catch { state.failed = true; app.exit(1); }
      }
    });
  };
  app.on('session-created', attach);
  app.whenReady().then(async () => {
    attach(session.defaultSession);
    state.ready = true; save();
    // Install the observer BEFORE importing the unchanged compiled host.
    await import(pathToFileURL(path.resolve(host)).href);
    state.hostImported = true; save();
  }).catch(() => { state.failed = true; save(); app.exit(1); });
}
module.exports = { observeRequest };
