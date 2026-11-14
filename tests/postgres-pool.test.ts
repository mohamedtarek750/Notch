import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPostgresPool,
  poolConfiguration,
  transportFor,
  websocketOptions,
} from "../src/server/postgres-pool";
const captured = vi.hoisted(
  () =>
    [] as Array<{
      address: string;
      options: { agent?: { proxy?: URL }; rejectUnauthorized?: boolean };
    }>,
);
vi.mock("ws", () => ({
  default: class TestWebSocket {
    constructor(address: string | URL, _protocols: unknown, options: unknown) {
      captured.push({
        address: String(address),
        options: options as (typeof captured)[number]["options"],
      });
    }
  },
}));
const fixture =
  "postgresql://synthetic:fixture-password@ep-fixture-pooler.eu-west-1.aws.neon.tech/pilot?sslmode=disable&channel_binding=require";
afterEach(() => vi.unstubAllEnvs());
describe("explicit official Neon transport and TLS/proxy policy", () => {
  it("retains TCP by default and requires explicit websocket selection", () => {
    vi.stubEnv("NEON_TRANSPORT", "");
    expect(transportFor()).toBe("tcp");
    expect(transportFor("tcp")).toBe("tcp");
    expect(transportFor("websocket")).toBe("websocket");
    expect(() => transportFor("fallback")).toThrow();
  });
  it("cannot weaken certificate verification through DSN sslmode", () => {
    const config = poolConfiguration(fixture, {
      max: 1,
      statement_timeout: 30000,
    });
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.enableChannelBinding).toBe(true);
    expect(new URL(config.connectionString!).searchParams.has("sslmode")).toBe(
      false,
    );
    expect(config.max).toBe(1);
    expect(config.statement_timeout).toBe(30000);
  });
  it("routes WSS through inherited HTTPS proxy and keeps certificate checks", async () => {
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    vi.stubEnv("HTTPS_PROXY", "http://unused.example:8080");
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("NO_PROXY", "");
    const options = await websocketOptions(
      "wss://ep-fixture-pooler.eu-west-1.aws.neon.tech/v2",
    );
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.handshakeTimeout).toBe(15000);
    expect(options.agent).toBeDefined();
    expect((options.agent as { proxy?: URL }).proxy?.hostname).toBe(
      "proxy.example",
    );
  });
  it("honors NO_PROXY without disabling secure WSS", async () => {
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    vi.stubEnv("no_proxy", ".neon.tech");
    const options = await websocketOptions(
      "wss://ep-fixture-pooler.eu-west-1.aws.neon.tech/v2",
    );
    expect(options.agent).toBeUndefined();
    expect(options.rejectUnauthorized).toBe(true);
  });
  it("rejects plaintext WebSockets and unrelated endpoints before credentials can be used", async () => {
    await expect(
      websocketOptions("ws://ep-fixture.neon.tech/v2"),
    ).rejects.toThrow();
    await expect(
      websocketOptions("wss://neon.tech.untrusted.example/v2"),
    ).rejects.toThrow();
    vi.stubEnv("NEON_TRANSPORT", "websocket");
    await expect(
      createPostgresPool("postgresql://test:fixture@untrusted.example/pilot"),
    ).rejects.toThrow("official Neon");
  });
  it("supports multiple Neon host pools without capturing another pool host in the global constructor", async () => {
    vi.stubEnv("NEON_TRANSPORT", "websocket");
    const a = await createPostgresPool(fixture);
    const b = await createPostgresPool(fixture.replace("-pooler", ""));
    const { neonConfig } = await import("@neondatabase/serverless");
    expect(neonConfig.useSecureWebSocket).toBe(true);
    expect(neonConfig.poolQueryViaFetch).toBe(false);
    expect(neonConfig.webSocketConstructor).toBeDefined();
    // Injected socket constructor records routing without making any network connection.
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    vi.stubEnv("no_proxy", "ep-fixture.eu-west-1.aws.neon.tech");
    const Socket = neonConfig.webSocketConstructor!;
    new Socket("wss://ep-fixture-pooler.eu-west-1.aws.neon.tech/v2");
    new Socket("wss://ep-fixture.eu-west-1.aws.neon.tech/v2");
    expect(captured.at(-2)?.options.agent?.proxy?.hostname).toBe(
      "proxy.example",
    );
    expect(captured.at(-1)?.options.agent).toBeUndefined();
    expect(captured.at(-2)?.options.rejectUnauthorized).toBe(true);
    expect(captured.at(-1)?.options.rejectUnauthorized).toBe(true);
    await a.end();
    await b.end();
  });
});
