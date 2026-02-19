import { describe, it, expect, beforeAll } from "vitest";

import { setupAccount, loginWithClientCredentials } from "./helpers/solidAccount";

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === "true";
const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

const CLOUD_A_PORT = process.env.CLOUD_PORT || "6300";
const CLOUD_B_PORT = process.env.CLOUD_B_PORT || "6400";
const CLOUD_A = `http://localhost:${CLOUD_A_PORT}`;
const CLOUD_B = `http://localhost:${CLOUD_B_PORT}`;

async function waitForService(url: string, maxRetries = 60, delayMs = 1000): Promise<boolean> {
  const statusUrl = `${url}/service/status`;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(statusUrl, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });

      if (res.status === 200) {
        const body = (await res.json().catch(() => null)) as Array<{ name?: string }> | null;
        if (Array.isArray(body)) {
          const names = new Set(body.map((item) => item?.name).filter(Boolean));
          if (names.has("css") && names.has("api")) {
            return true;
          }
        }
      }
    } catch {
      // service not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return false;
}

suite("Multi-node Center Cluster (dual cloud)", () => {
  beforeAll(async () => {
    const [cloudAReady, cloudBReady] = await Promise.all([waitForService(CLOUD_A), waitForService(CLOUD_B)]);

    if (!cloudAReady || !cloudBReady) {
      throw new Error(`Dual-cloud services are not ready: cloud=${cloudAReady}, cloud_b=${cloudBReady}`);
    }

  }, 120000);

  it(
    "should create pods independently on both centers",
    async () => {
      const [accountA, accountB] = await Promise.all([
        setupAccount(CLOUD_A, "cloud-a"),
        setupAccount(CLOUD_B, "cloud-b"),
      ]);

      expect(accountA).not.toBeNull();
      expect(accountB).not.toBeNull();

      expect(accountA!.issuer).toContain(`localhost:${CLOUD_A_PORT}`);
      expect(accountB!.issuer).toContain(`localhost:${CLOUD_B_PORT}`);
      expect(accountA!.podUrl).toContain(`localhost:${CLOUD_A_PORT}`);
      expect(accountB!.podUrl).toContain(`localhost:${CLOUD_B_PORT}`);

      const [sessionA, sessionB] = await Promise.all([
        loginWithClientCredentials(accountA!),
        loginWithClientCredentials(accountB!),
      ]);

      expect(sessionA.info.isLoggedIn).toBe(true);
      expect(sessionB.info.isLoggedIn).toBe(true);

      const resourceA = `${accountA!.podUrl}multi-node-a-${Date.now()}.txt`;
      const resourceB = `${accountB!.podUrl}multi-node-b-${Date.now()}.txt`;

      const writeA = await sessionA.fetch(resourceA, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "Hello from cloud A",
      });
      const writeB = await sessionB.fetch(resourceB, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "Hello from cloud B",
      });

      expect([200, 201]).toContain(writeA.status);
      expect([200, 201]).toContain(writeB.status);

      const [readA, readB] = await Promise.all([sessionA.fetch(resourceA), sessionB.fetch(resourceB)]);
      expect(readA.status).toBe(200);
      expect(readB.status).toBe(200);
      expect(await readA.text()).toBe("Hello from cloud A");
      expect(await readB.text()).toBe("Hello from cloud B");

      await Promise.all([
        sessionA.fetch(resourceA, { method: "DELETE" }).catch(() => {}),
        sessionB.fetch(resourceB, { method: "DELETE" }).catch(() => {}),
        sessionA.logout(),
        sessionB.logout(),
      ]);
    },
    90000,
  );

  it("should keep Cloud A and Cloud B OIDC issuers isolated", async () => {
    const [oidcARes, oidcBRes] = await Promise.all([
      fetch(`${CLOUD_A}/.well-known/openid-configuration`),
      fetch(`${CLOUD_B}/.well-known/openid-configuration`),
    ]);

    expect(oidcARes.status).toBe(200);
    expect(oidcBRes.status).toBe(200);

    const [oidcA, oidcB] = await Promise.all([
      oidcARes.json() as Promise<{ issuer: string }>,
      oidcBRes.json() as Promise<{ issuer: string }>,
    ]);

    expect(oidcA.issuer).toContain(`localhost:${CLOUD_A_PORT}`);
    expect(oidcB.issuer).toContain(`localhost:${CLOUD_B_PORT}`);
    expect(oidcA.issuer).not.toEqual(oidcB.issuer);
  });
});
