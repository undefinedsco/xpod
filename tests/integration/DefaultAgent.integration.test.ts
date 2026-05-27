/**
 * DefaultAgent availability smoke tests.
 *
 * Real DefaultAgent E2E (needs DEFAULT_API_KEY and local Claude CLI)
 * moved to tests/manual/DefaultAgent.manual.test.ts.
 */

import { describe, it, expect } from "vitest";

import {
  isDefaultAgentAvailable,
  getDefaultAgentConfig,
} from "../../src/api/chatkit/default-agent";

describe("DefaultAgent Availability", () => {
  it("should correctly report availability based on platform API config", () => {
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalProvider = process.env.DEFAULT_PROVIDER;

    try {
      delete process.env.DEFAULT_API_KEY;
      delete process.env.DEFAULT_API_BASE;
      delete process.env.DEFAULT_PROVIDER;
      expect(isDefaultAgentAvailable()).toBe(false);

      process.env.DEFAULT_API_KEY = "test-key";
      expect(isDefaultAgentAvailable()).toBe(true);

      delete process.env.DEFAULT_API_KEY;
      process.env.DEFAULT_API_BASE = "https://ai-gateway.example.com/v1";
      expect(isDefaultAgentAvailable()).toBe(true);
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
    const config = getDefaultAgentConfig();

    expect(config.provider).toBe(process.env.DEFAULT_PROVIDER || "undefineds");
    expect(config.model).toBe(process.env.DEFAULT_MODEL || "linx-lite");
  });
});
