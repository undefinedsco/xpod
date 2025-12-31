import { AppRunner, App } from '@solid/community-server';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';

// Use local config instead of server config to avoid Redis dependency
const configFiles = [
  path.join(process.cwd(), 'config/main.local.json'),
  path.join(process.cwd(), 'config/extensions.local.json'),
];

describe('Server Mode Root Access (Drizzle)', () => {
  let app: App;
  let baseUrl: string;
  
  // Use unique paths for test isolation
  const testDataDir = '.test-data/server-mode-root';
  const sparqlDbPath = `${testDataDir}/quadstore.sqlite`;
  const rootFilePath = `${testDataDir}/data`;

  beforeAll(async () => {
    // Ensure test data directory exists
    fs.mkdirSync(testDataDir, { recursive: true });
    fs.mkdirSync(rootFilePath, { recursive: true });
    
    // Use isolated databases for this test
    process.env.CSS_SPARQL_ENDPOINT = `sqlite:${sparqlDbPath}`;
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
        'urn:solid-server:default:variable:sparqlEndpoint': `sqlite:${sparqlDbPath}`,
        'urn:solid-server:default:variable:rootFilePath': rootFilePath,
      },
    });

    await app.start();
    baseUrl = 'http://localhost:4000/';
  }, 30000);

  afterAll(async () => {
    if (app) {
      await app.stop();
    }
    // Cleanup test data directory
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  }, 15000);

  it('should return 200 OK with SPA HTML for GET /', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    
    const contentType = response.headers.get('content-type');
    expect(contentType).toContain('text/html');
    
    const text = await response.text();
    // Should contain SPA markers
    expect(text).toContain('<!doctype html>');
    expect(text).toContain('<div id="root">');
  });

  it('should return SPA HTML even with Accept: text/turtle (static-root mode)', async () => {
    // In static-root mode, root path always returns the static HTML page
    // regardless of Accept header. This is by design - Pods are at /{username}/
    const response = await fetch(baseUrl, {
      headers: {
        'Accept': 'text/turtle'
      }
    });
    
    expect(response.status).toBe(200);
    
    const contentType = response.headers.get('content-type');
    expect(contentType).toContain('text/html');
    
    const text = await response.text();
    expect(text).toContain('<!doctype html>');
  });
});
