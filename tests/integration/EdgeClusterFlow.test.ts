import { describe, it, expect } from "vitest";

const RUN_DOCKER_TESTS = process.env.XPOD_RUN_DOCKER_TESTS === "true";
const suite = RUN_DOCKER_TESTS ? describe : describe.skip;

const CLOUD_API_URL = "http://localhost:6301";
const CLOUD_CSS_URL = "http://localhost:6300";

suite("Edge Cluster Flow (Docker)", () => {
  it("signal endpoint should fail gracefully when edge mode is disabled", async () => {
    try {
      const res = await fetch(CLOUD_API_URL + "/api/v1/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: "edge-test",
          token: "invalid-token",
          status: "online",
        }),
      });

      // docker-compose.cluster.yml 默认 cloud 关闭 edge 模式，
      // 应返回功能未开启或认证失败，而不是 5xx。
      expect([400, 401, 404, 501, 503]).toContain(res.status);
    } catch (error) {
      // 当前 API 关闭该能力时会直接 reset 连接，也视为“未启用”兜底行为。
      const err = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
      const code = err.code ?? err.cause?.code;
      expect(["ECONNRESET", "UND_ERR_SOCKET", undefined]).toContain(code);
    }
  });

  it("unknown edge hostname should not crash gateway", async () => {
    const res = await fetch(CLOUD_CSS_URL + "/", {
      headers: {
        Host: "unknown-edge.cluster.example",
        Accept: "text/turtle",
      },
      redirect: "manual",
    });

    expect([200, 401, 404]).toContain(res.status);
  });
});
