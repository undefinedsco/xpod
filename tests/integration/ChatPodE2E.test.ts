import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { ApiServer } from "../../src/api/ApiServer";
import { InternalPodService } from "../../src/api/service/InternalPodService";
import { VercelChatService } from "../../src/api/service/VercelChatService";
import { registerChatRoutes } from "../../src/api/handlers/ChatHandler";
import { AuthMiddleware } from "../../src/api/middleware/AuthMiddleware";
import { setupAccount, type AccountSetup } from "./helpers/solidAccount";

const RUN_DOCKER_TESTS = process.env.XPOD_RUN_DOCKER_TESTS === "true";
const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === "true";
const shouldRun = RUN_DOCKER_TESTS || RUN_INTEGRATION_TESTS;
const suite = shouldRun ? describe : describe.skip;

const solidBaseUrl = RUN_DOCKER_TESTS
  ? "http://localhost:5739"
  : (process.env.XPOD_SERVER_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

suite("Chat Pod E2E Integration (Real Network)", () => {
  let server: ApiServer;
  let mockAIServer: Server;
  const port = 3107;
  const aiPort = 11434;
  const baseUrl = `http://localhost:${port}`;

  let lastAIRequest: any = null;
  let originalFetch: typeof fetch;
  let account: AccountSetup;

  beforeAll(async () => {
    const createdAccount = await setupAccount(solidBaseUrl, "chat-e2e");
    if (!createdAccount) {
      throw new Error(`Failed to setup account on ${solidBaseUrl}`);
    }
    account = createdAccount;

    mockAIServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        lastAIRequest = {
          url: req.url,
          headers: req.headers,
          body: JSON.parse(body),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "resp_e2e",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          output: [
            {
              id: "msg_e2e",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Real E2E Response", annotations: [] }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        }));
      });
    }).listen(aiPort);

    const podService = new InternalPodService({
      tokenEndpoint: `${account.issuer.replace(/\/$/, "")}/.oidc/token`,
      apiKeyStore: {
        findByClientId: async (clientId: string) => {
          if (clientId !== account.clientId) {
            return undefined;
          }
          return {
            clientId: account.clientId,
            clientSecret: account.clientSecret,
            webId: account.webId,
            accountId: "chat-e2e-account",
            createdAt: new Date(),
          };
        },
      } as any,
    });

    originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      const requestUrl = url.toString();
      if (requestUrl.includes("/.data/model-providers/")) {
        if (requestUrl.includes("/-/sparql")) {
          const method = init?.method?.toUpperCase() ?? "GET";
          const query = (() => {
            try {
              return new URL(requestUrl).searchParams.get("query") ?? "";
            } catch {
              return "";
            }
          })();
          const body = (() => {
            const raw = init?.body;
            if (typeof raw === "string") {
              return raw;
            }
            if (raw instanceof URLSearchParams) {
              return raw.toString();
            }
            if (raw instanceof Uint8Array) {
              return Buffer.from(raw).toString("utf8");
            }
            return "";
          })();
          const combined = `${query} ${body}`.toUpperCase();

          if (combined.includes("ASK") || method === "HEAD") {
            return new Response(JSON.stringify({ boolean: true }), {
              status: 200,
              headers: { "Content-Type": "application/sparql-results+json" },
            });
          }

          const selectPayload = {
            head: { vars: ["subject", "id", "enabled", "apiKey", "baseUrl", "proxy", "models", "updatedAt"] },
            results: {
              bindings: [{
                subject: { type: "uri", value: `${account.podUrl}.data/model-providers/openai#it` },
                id: { type: "literal", value: "openai" },
                enabled: { type: "literal", datatype: "http://www.w3.org/2001/XMLSchema#boolean", value: "true" },
                apiKey: { type: "literal", value: "sk-real-e2e-key" },
                baseUrl: { type: "literal", value: `http://localhost:${aiPort}/v1` },
                updatedAt: {
                  type: "literal",
                  datatype: "http://www.w3.org/2001/XMLSchema#dateTime",
                  value: new Date().toISOString(),
                },
              }],
            },
          };

          return new Response(JSON.stringify(selectPayload), {
            status: 200,
            headers: { "Content-Type": "application/sparql-results+json" },
          });
        }

        return new Response("", {
          status: 200,
          headers: { "Content-Type": "text/turtle" },
        });
      }

      return originalFetch(url, init);
    };

    const chatService = new VercelChatService(podService);
    const authMiddleware = new AuthMiddleware({
      authenticator: {
        canAuthenticate: () => true,
        authenticate: async () => ({
          success: true,
          context: { type: "solid", clientId: account.clientId, webId: account.webId, viaApiKey: true },
        }),
      } as any,
    });

    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService });
    await server.start();
  }, 60000);

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (mockAIServer) {
      await new Promise<void>((resolve) => mockAIServer.close(() => resolve()));
    }
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it("should perform real login and simulated data fetch", async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer any" },
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "ping" }] }),
    });

    if (response.status !== 200) {
      const errBody = await response.text();
      console.error("[ChatPodE2E error]", errBody);
    }

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.choices[0].message.content).toBe("Real E2E Response");
    expect(["Bearer sk-real-e2e-key", "Bearer ollama"]).toContain(lastAIRequest.headers.authorization);
  }, 15000);
});
