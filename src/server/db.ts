import { Pool, type PoolClient } from "pg";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError } from "./errors";
export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  tenant(tenantId: string): Database;
  close(): Promise<void>;
}
interface Driver extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
const globals = globalThis as typeof globalThis & {
  __tilwaDriver?: Promise<Driver>;
};
async function driver(): Promise<Driver> {
  if (!globals.__tilwaDriver)
    globals.__tilwaDriver = (async () => {
      if (process.env.LOCAL_DATABASE === "1") {
        if (process.env.VERCEL || process.env.TILWA_ENV === "production")
          throw new AppError(503, "DATABASE_UNAVAILABLE");
        const { PGlite } = await import("@electric-sql/pglite");
        const path =
          process.env.LOCAL_DATABASE_PATH ||
          process.env.PGLITE_PATH ||
          ".tilwa-private/database";
        if (!path.startsWith("memory://"))
          await mkdir(dirname(path), { recursive: true });
        const pg = new PGlite(path);
        await pg.waitReady;
        return {
          query: async <T>(sql: string, params: unknown[] = []) => {
            if (!params.length) {
              const results = await pg.exec(sql);
              return { rows: (results.at(-1)?.rows ?? []) as T[] };
            }
            const result = await pg.query(sql, params);
            return { rows: result.rows as T[] };
          },
          transaction: async <T>(fn: (tx: Queryable) => Promise<T>) =>
            pg.transaction(async (tx) =>
              fn({
                query: async <R>(sql: string, params: unknown[] = []) => {
                  if (!params.length) {
                    const results = await tx.exec(sql);
                    return { rows: (results.at(-1)?.rows ?? []) as R[] };
                  }
                  const result = await tx.query(sql, params);
                  return { rows: result.rows as R[] };
                },
              }),
            ),
          close: () => pg.close(),
        };
      }
      if (!process.env.DATABASE_URL)
        throw new AppError(503, "DATABASE_UNAVAILABLE");
      const connection = new URL(process.env.DATABASE_URL);
      // Force certificate verification; sslmode parameters must not override it.
      for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
        connection.searchParams.delete(key);
      const pool = new Pool({
        connectionString: connection.toString(),
        ssl: { rejectUnauthorized: true },
        max: 5,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 20000,
      });
      return {
        query: async <T>(sql: string, params: unknown[] = []) => {
          const result = await pool.query(sql, params);
          return { rows: result.rows as T[] };
        },
        transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
          const client: PoolClient = await pool.connect();
          try {
            await client.query("BEGIN");
            const result = await fn({
              query: async <R>(sql: string, params: unknown[] = []) => {
                const result = await client.query(sql, params);
                return { rows: result.rows as R[] };
              },
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
        },
        close: () => pool.end(),
      };
    })().catch((error) => {
      delete globals.__tilwaDriver;
      throw error;
    });
  return globals.__tilwaDriver;
}
function database(tenantId?: string): Database {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const d = await driver();
      if (!tenantId) return d.query<T>(sql, params);
      return d.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.tenant_id',$1,true)", [
          tenantId,
        ]);
        return tx.query<T>(sql, params);
      });
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      const d = await driver();
      return d.transaction(async (tx) => {
        if (tenantId)
          await tx.query("SELECT set_config('app.tenant_id',$1,true)", [
            tenantId,
          ]);
        return fn(tx);
      });
    },
    tenant: (id: string) => database(id),
    async close() {
      if (globals.__tilwaDriver) {
        await (await globals.__tilwaDriver).close();
        delete globals.__tilwaDriver;
      }
    },
  };
}
export const db = database();
export function scopedDb(ctx: { tenantId: string }): Database {
  return db.tenant(ctx.tenantId);
}
