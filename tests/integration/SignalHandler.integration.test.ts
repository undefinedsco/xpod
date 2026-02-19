import { beforeAll, describe, it, expect } from "vitest";
import { Session } from "@inrupt/solid-client-authn-node";
import { setupAccount } from "./helpers/solidAccount";
import { resolveSolidIntegrationConfig } from "../http/utils/integrationEnv";

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === "true";
const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

const { baseUrl: envBaseUrl, oidcIssuer: envIssuer } = resolveSolidIntegrationConfig();
const STANDALONE_BASE = (process.env.CSS_BASE_URL || `http://localhost:${process.env.STANDALONE_PORT || '5739'}`).replace(/\/$/, '');
const dockerApiBaseUrl = `${STANDALONE_BASE}/`;
const dockerIdpBaseUrl = STANDALONE_BASE;

const externalApiBaseUrl = envBaseUrl;
const externalIssuer = envIssuer;
const externalClientId = process.env.SOLID_CLIENT_ID;
const externalClientSecret = process.env.SOLID_CLIENT_SECRET;
const useDockerDefaults = !externalClientId || !externalClientSecret;

suite("SignalHandler Integration", () => {
  let session: Session;
  let authFetch: typeof fetch;
  let createdNodeId: string;

  const baseUrl = `${(useDockerDefaults ? dockerApiBaseUrl : externalApiBaseUrl).replace(/\/$/, "")}/`;

  beforeAll(async () => {
    session = new Session();

    if (useDockerDefaults) {
      const account = await setupAccount(dockerIdpBaseUrl, "signal");
      if (!account) {
        throw new Error("Failed to setup account for SignalHandler integration test.");
      }

      await session.login({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        oidcIssuer: account.issuer,
        tokenType: "DPoP",
      });
    } else {
      await session.login({
        clientId: externalClientId,
        clientSecret: externalClientSecret,
        oidcIssuer: externalIssuer,
        tokenType: "DPoP",
      });
    }

    if (!session.info.isLoggedIn) {
      throw new Error("Failed to login for SignalHandler integration test.");
    }

    authFetch = session.fetch.bind(session);
  }, 30000);

  it("should create a new node to signal against", async () => {
    const response = await authFetch(`${baseUrl}v1/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Integration Test Node" }),
    });

    expect(response.status).toBe(201);
    const data = await response.json() as { success: boolean; nodeId: string };
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();

    createdNodeId = data.nodeId;
  });

  it("should accept signal from registered node and update metadata", async () => {
    const response = await authFetch(`${baseUrl}v1/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: createdNodeId,
        version: "1.0.0",
        status: "online",
        pods: ["https://pod1.example.com/", "https://pod2.example.com/"],
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as {
      status: string;
      nodeId: string;
      metadata: { status?: string; version?: string };
    };

    expect(data.status).toBe("ok");
    expect(data.nodeId).toBe(createdNodeId);
    if (data.metadata?.status) expect(data.metadata.status).toBe("online");
    expect(data.metadata?.version).toBe("1.0.0");
  });

  it("should verify node status via GET /v1/nodes/:id", async () => {
    const response = await authFetch(`${baseUrl}v1/nodes/${createdNodeId}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    expect(response.status).toBe(200);
    const data = await response.json() as {
      nodeId: string;
      metadata?: { status?: string };
      lastSeen?: string;
    };

    expect(data.nodeId).toBe(createdNodeId);
    if (data.metadata?.status) expect(data.metadata.status).toBe("online");
    expect(data.lastSeen).toBeDefined();
  });

  it("should return 403/404 when signaling a non-owned or missing node", async () => {
    const randomId = "00000000-0000-0000-0000-000000000000";
    const response = await authFetch(`${baseUrl}v1/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: randomId, status: "online" }),
    });

    expect([403, 404]).toContain(response.status);
  });

  it("should return 400 for invalid request body", async () => {
    const response = await authFetch(`${baseUrl}v1/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "online" }),
    });

    expect(response.status).toBe(400);
  });
});
