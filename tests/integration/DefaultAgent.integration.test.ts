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
  it("should correctly report availability based on DEFAULT_API_KEY", () => {
    const originalKey = process.env.DEFAULT_API_KEY;

    delete process.env.DEFAULT_API_KEY;
    expect(isDefaultAgentAvailable()).toBe(false);

    process.env.DEFAULT_API_KEY = "test-key";
    expect(isDefaultAgentAvailable()).toBe(true);

    if (originalKey) {
      process.env.DEFAULT_API_KEY = originalKey;
    } else {
      delete process.env.DEFAULT_API_KEY;
    }
  });

  it("should return correct default config", () => {
    const config = getDefaultAgentConfig();

    expect(config.provider).toBe(process.env.DEFAULT_PROVIDER || "openrouter");
    expect(config.model).toBe(process.env.DEFAULT_MODEL || "stepfun/step-3.5-flash:free");
  });
});
