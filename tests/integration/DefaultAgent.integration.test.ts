/**
 * DefaultAgent availability smoke tests.
 *
 * Real DefaultAgent E2E (needs AI_CONNECTIONS_API_KEY and local Claude CLI)
 * moved to tests/manual/DefaultAgent.manual.test.ts.
 */

import { describe, it, expect } from "vitest";

import {
  isDefaultAgentAvailable,
  getDefaultAgentConfig,
} from "../../src/api/chatkit/default-agent";

describe("DefaultAgent Availability", () => {
  it("should correctly report availability based on invocation AI Connection config", () => {
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalProvider = process.env.DEFAULT_PROVIDER;

    try {
      delete process.env.DEFAULT_API_KEY;
      delete process.env.DEFAULT_API_BASE;
      delete process.env.DEFAULT_PROVIDER;
      expect(isDefaultAgentAvailable()).toBe(false);

      process.env.DEFAULT_API_KEY = "test-key";
      process.env.DEFAULT_API_BASE = "https://raw-provider.example/v1";
      expect(isDefaultAgentAvailable()).toBe(false);

      expect(isDefaultAgentAvailable({
        connection: {
          baseUrl: "http://127.0.0.1:3000/v1",
          apiKey: "gateway-key",
        },
      })).toBe(true);
    } finally {
      if (originalKey) {
        process.env.DEFAULT_API_KEY = originalKey;
      } else {
        delete process.env.DEFAULT_API_KEY;
      }
      if (originalBase) {
        process.env.DEFAULT_API_BASE = originalBase;
      } else {
        delete process.env.DEFAULT_API_BASE;
      }
      if (originalProvider) {
        process.env.DEFAULT_PROVIDER = originalProvider;
      } else {
        delete process.env.DEFAULT_PROVIDER;
      }
    }
  });


  it("should return correct default config", () => {
    const config = getDefaultAgentConfig({
      connection: {
        baseUrl: "http://127.0.0.1:3000/v1",
        apiKey: "gateway-key",
      },
      model: "linx",
    });

    expect(config.connection?.baseUrl).toBe("http://127.0.0.1:3000/v1");
    expect(config.connection?.apiKey).toBe("gateway-key");
    expect(config.model).toBe("linx");
  });
});
