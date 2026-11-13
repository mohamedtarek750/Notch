import { Pool as TcpPool, type PoolConfig } from "pg";
import type { ClientOptions } from "ws";

export interface PoolResult<T> {
  rows: T[];
  rowCount: number | null;
}
export interface PostgresClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PoolResult<T>>;
  release(): void;
}
export interface PostgresPool {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PoolResult<T>>;
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}
export type PoolOverrides = Pick<
  PoolConfig,
  "max" | "connectionTimeoutMillis" | "idleTimeoutMillis" | "statement_timeout"
>;
export function transportFor(
  value = process.env.NEON_TRANSPORT,
): "tcp" | "websocket" {
  if (value === undefined || value === "" || value === "tcp") return "tcp";
  if (value === "websocket") return "websocket";
  throw new Error("NEON_TRANSPORT must be tcp or websocket.");
}
export function poolConfiguration(
  value: string,
  overrides: PoolOverrides = {},
): PoolConfig {
  const connection = new URL(value);
  if (!["postgres:", "postgresql:"].includes(connection.protocol))
    throw new Error("A PostgreSQL connection is required.");
  // URI SSL flags must not override server certificate verification.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    connection.searchParams.delete(key);
  return {
    connectionString: connection.toString(),
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
    max: 5,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 20000,
    ...overrides,
  };
}
/** WSS is HTTPS: preserve inherited proxy routing, NO_PROXY and platform CA trust. */
async function websocketOptionsResolver() {
  const [{ getProxyForUrl }, { HttpsProxyAgent }] = await Promise.all([
    import("proxy-from-env"),
    import("https-proxy-agent"),
  ]);
  return (address: string | URL): ClientOptions => {
    const url = new URL(address);
    if (url.protocol !== "wss:" || !url.hostname.endsWith(".neon.tech"))
      throw new Error(
        "Only the official secure Neon WebSocket endpoint is supported.",
      );
    const httpsUrl = new URL(url);
    httpsUrl.protocol = "https:";
    const proxy = getProxyForUrl(httpsUrl.toString());
    const options: ClientOptions = {
      rejectUnauthorized: true,
      handshakeTimeout: 15000,
    };
    if (proxy)
      options.agent = new HttpsProxyAgent(proxy, { rejectUnauthorized: true });
    return options;
  };
}
export async function websocketOptions(
  address: string | URL,
): Promise<ClientOptions> {
  return (await websocketOptionsResolver())(address);
}
export async function createPostgresPool(
  value: string,
  overrides: PoolOverrides = {},
): Promise<PostgresPool> {
  const config = poolConfiguration(value, overrides);
  if (transportFor() === "tcp")
    return new TcpPool(config) as unknown as PostgresPool;
  const host = new URL(value).hostname;
  if (!host.endsWith(".neon.tech"))
    throw new Error(
      "WebSocket transport requires an official Neon database hostname.",
    );
  const [{ Pool, neonConfig }, { default: WebSocket }] = await Promise.all([
    import("@neondatabase/serverless"),
    import("ws"),
  ]);
  // The official driver carries the Postgres wire protocol inside certificate-verified WSS.
  // Keep its documented secure WSS defaults; use Pool rather than HTTP fetch to retain sessions.
  neonConfig.useSecureWebSocket = true;
  neonConfig.poolQueryViaFetch = false;
  const optionsFor = await websocketOptionsResolver();
  class ProxiedWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, optionsFor(address));
    }
  }
  neonConfig.webSocketConstructor = ProxiedWebSocket;
  return new Pool(config) as unknown as PostgresPool;
}
