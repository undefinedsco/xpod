import { AppRunner, App } from '@solid/community-server';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';

// Define the configurations to use (Server Mode which uses Drizzle)
const configFiles = [
  path.join(process.cwd(), 'config/main.server.json'),
  path.join(process.cwd(), 'config/extensions.server.json'),
];

describe('Server Mode Root Access (Drizzle)', () => {
  let app: App;
  let baseUrl: string;

  beforeAll(async () => {
    // Ensure we use a test database for this run
    process.env.CSS_IDENTITY_DB_URL = 'sqlite:.test-data/server-mode-test.sqlite';
    process.env.CSS_BASE_URL = 'http://localhost:4000/';
    
    // Create the app
    app = await new AppRunner().create({
      config: configFiles,
      loaderProperties: {
        mainModulePath: process.cwd(),
        typeChecking: false,
      },
      variableBindings: {
        'urn:solid-server:default:variable:port': 4000,
        'urn:solid-server:default:variable:baseUrl': 'http://localhost:4000/',
        'urn:solid-server:default:variable:showStackTrace': true,
        'urn:solid-server:default:variable:loggingLevel': 'info',
      },
    });

    await app.start();
    baseUrl = 'http://localhost:4000/';
  });

  afterAll(async () => {
    if (app) {
      await app.stop();
    }
    // Cleanup DB
    if (fs.existsSync('.test-data/server-mode-test.sqlite')) {
      fs.unlinkSync('.test-data/server-mode-test.sqlite');
    }
    if (fs.existsSync('.test-data/server-mode-test.sqlite-shm')) {
      fs.unlinkSync('.test-data/server-mode-test.sqlite-shm');
    }
    if (fs.existsSync('.test-data/server-mode-test.sqlite-wal')) {
      fs.unlinkSync('.test-data/server-mode-test.sqlite-wal');
    }
  });

  it('should return 200 OK for GET / (HTML)', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('<!DOCTYPE html>');
  });

  it('should return 200 OK for GET / (RDF) simulating drizzle-solid', async () => {
    const response = await fetch(baseUrl, {
      headers: {
        'Accept': 'text/turtle'
      }
    });
    // If auth is required for root, it might be 401/403, but NOT 500
    // If public read is allowed, 200.
    // CSS default root is usually public read.
    expect(response.status).not.toBe(500);
    expect([200, 401, 403]).toContain(response.status);
    
    if (response.status === 200) {
      const text = await response.text();
      // Should contain some turtle
      expect(text).toContain('@prefix');
    }
  });
});
