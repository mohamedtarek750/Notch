import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  databaseIdentity,
  migrationConnection,
  previewSessionSetting,
  previewGeminiSetting,
  readCliToken,
  existingDeploymentBlockers,
  inspectInventory,
  previewVariablePlan,
  schemaContract,
  validateInventory,
  type SchemaContract,
  type Sql,
} from "../scripts/deploy-existing";

const injected = {
  DATABASE_URL:
    "postgresql://fixture_user:fixture_password@ep-test.us-east-1.aws.neon.tech/fixture_db?sslmode=require&channel_binding=require",
  VERCEL_TOKEN: "offline-fixture-only",
  GEMINI_API_KEY: "offline-fixture-only",
  SESSION_SECRET: "offline-fixture-session-secret-with-32-characters",
  VERCEL_PROJECT_NAME: "tilwa",
  VERCEL_TEAM_SLUG: "mohamedtarek750s-projects",
  DEPLOY_EXISTING: "1",
};
let contract: SchemaContract;
let files: { name: string; sql: string }[];
const pg = new PGlite();
const sql: Sql = {
  query: async <T>(statement: string, params: unknown[] = []) => ({
    rows: (await pg.query(statement, params)).rows as T[],
  }),
};
beforeAll(async () => {
  await pg.waitReady;
  const names = (await readdir("migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  files = await Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(`migrations/${name}`, "utf8"),
    })),
  );
  contract = schemaContract(files);
}, 30000);
afterAll(() => pg.close());
describe("existing-resource deployment guard (offline)", () => {
  it("requires injected secrets, target and opt-in without any provider requests", () => {
    expect(existingDeploymentBlockers({}).join(" ")).toContain("DATABASE_URL");
    expect(existingDeploymentBlockers({}).join(" ")).toContain(
      "VERCEL_PROJECT",
    );
    expect(existingDeploymentBlockers({}).join(" ")).toContain(
      "DEPLOY_EXISTING",
    );
    expect(existingDeploymentBlockers(injected)).toEqual([]);
    expect(
      existingDeploymentBlockers({
        ...injected,
        VERCEL_ENV: "production",
      }).join(" "),
    ).toContain("Only real Neon");
    expect(
      existingDeploymentBlockers({ ...injected, LOCAL_DATABASE: "1" }).join(
        " ",
      ),
    ).toContain("Only real Neon");
  });
  it("accepts one existing owner URL and optionally the same-branch migration alias", () => {
    const owner = injected.DATABASE_URL;
    const pooled = owner
      .replace("ep-test.", "ep-test-pooler.")
      .replace(
        "fixture_user:fixture_password",
        "runtime_user:runtime_password",
      );
    expect(databaseIdentity(owner)).toBe(databaseIdentity(pooled));
    expect(
      existingDeploymentBlockers({
        ...injected,
        DATABASE_URL: pooled,
        MIGRATION_DATABASE_URL: owner,
      }),
    ).toEqual([]);
    expect(
      existingDeploymentBlockers({
        ...injected,
        MIGRATION_DATABASE_URL: owner.replace("ep-test", "ep-other"),
      }).join(" "),
    ).toContain("same Neon branch");
    expect(
      existingDeploymentBlockers({
        ...injected,
        DATABASE_URL: "not-a-secret-but-invalid",
      }).join(" "),
    ).toContain("valid TLS Neon");
    expect(
      existingDeploymentBlockers({
        ...injected,
        DATABASE_URL: owner.replace("neon.tech", "example.com"),
      }).join(" "),
    ).toContain("valid TLS Neon");
  });
  it("uses supplied Neon aliases in order without requesting a new credential", () => {
    const uri = injected.DATABASE_URL;
    expect(migrationConnection({ DATABASE_URL: uri })).toBe(uri);
    expect(
      migrationConnection({
        DATABASE_URL: uri,
        POSTGRES_URL_NON_POOLING: "third",
      }),
    ).toBe("third");
    expect(
      migrationConnection({
        DATABASE_URL: uri,
        POSTGRES_URL_NON_POOLING: "third",
        DATABASE_URL_UNPOOLED: "second",
      }),
    ).toBe("second");
    expect(
      migrationConnection({
        DATABASE_URL: uri,
        DATABASE_URL_UNPOOLED: "second",
        MIGRATION_DATABASE_URL: "first",
      }),
    ).toBe("first");
    expect(
      existingDeploymentBlockers({ ...injected, DATABASE_URL_UNPOOLED: uri }),
    ).toEqual([]);
    expect(
      existingDeploymentBlockers({
        ...injected,
        POSTGRES_URL_NON_POOLING: uri,
      }),
    ).toEqual([]);
  });
  it("preserves an existing Preview session secret or generates one only for initial setup", () => {
    expect(
      existingDeploymentBlockers({ ...injected, SESSION_SECRET: undefined }),
    ).toEqual([]);
    expect(
      previewSessionSetting([
        { id: "session-id", key: "SESSION_SECRET", target: ["preview"] },
      ]),
    ).toEqual({});
    expect(
      previewSessionSetting([]).SESSION_SECRET.length,
    ).toBeGreaterThanOrEqual(32);
    expect(previewSessionSetting([], injected.SESSION_SECRET)).toEqual({
      SESSION_SECRET: injected.SESSION_SECRET,
    });
    expect(() => previewSessionSetting([], "short")).toThrow("32 characters");
  });
  it("accepts an empty PostgreSQL database using read-only inventory", async () => {
    await pg.query("BEGIN READ ONLY");
    const inventory = await inspectInventory(sql);
    expect(validateInventory(inventory, contract)).toBe("empty");
    await pg.query("COMMIT");
    expect(
      (
        await pg.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
        )
      ).rows,
    ).toEqual([]);
  });
  it("excludes provider-managed Neon Auth metadata and never reads or changes its rows", async () => {
    await pg.exec(
      `CREATE SCHEMA neon_auth; CREATE TABLE neon_auth."user"(id text, private_value text); INSERT INTO neon_auth."user" VALUES('provider-user','do-not-read-in-inventory');`,
    );
    const statements: string[] = [];
    const observed: Sql = {
      query: async <T>(statement: string, params?: unknown[]) => {
        statements.push(statement);
        return sql.query<T>(statement, params);
      },
    };
    const inventory = await inspectInventory(observed);
    expect(
      inventory.relations.some(
        (relation) => relation.schema_name === "neon_auth",
      ),
    ).toBe(false);
    expect(validateInventory(inventory, contract)).toBe("empty");
    expect(
      statements.every((statement) => !statement.includes("FROM neon_auth")),
    ).toBe(true);
    expect(
      (await pg.query('SELECT count(*)::int AS count FROM neon_auth."user"'))
        .rows,
    ).toEqual([{ count: 1 }]);
  });
  it("preserves a remote Gemini Preview key without forwarding the local proxy value", () => {
    expect(
      previewGeminiSetting([
        { id: "g", key: "GEMINI_API_KEY", target: ["preview"] },
      ]),
    ).toEqual({});
    expect(
      previewGeminiSetting([
        { id: "g", key: "GEMINI_API_KEY", target: ["production", "preview"] },
      ]),
    ).toEqual({});
    expect(() => previewGeminiSetting([])).toThrow(
      "local proxy binding will not be copied",
    );
    expect(() =>
      previewGeminiSetting([
        {
          id: "g",
          key: "GEMINI_API_KEY",
          target: ["preview"],
          gitBranch: "unrelated-branch",
        },
      ]),
    ).toThrow("encrypted Preview settings");
    expect(previewGeminiSetting([], "explicit-raw-offline-fixture")).toEqual({
      GEMINI_API_KEY: "explicit-raw-offline-fixture",
    });
  });
  it("uses an existing private CLI token when present and rejects malformed auth without exposing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tilwa-cli-auth-test-"));
    try {
      expect(await readCliToken(directory)).toBeUndefined();
      await writeFile(
        join(directory, "auth.json"),
        JSON.stringify({ token: "offline-fixture-token" }),
        { mode: 0o600 },
      );
      expect(await readCliToken(directory)).toBe("offline-fixture-token");
      await writeFile(
        join(directory, "auth.json"),
        "{malformed-sensitive-fixture",
      );
      await expect(readCliToken(directory)).rejects.toThrow(
        "CLI login could not be read",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("refuses unrelated tables and overlapping names without a Tilwa migration ledger", async () => {
    await pg.exec("CREATE TABLE unrelated_customer_data (id text)");
    const unrelated = await inspectInventory(sql);
    expect(() => validateInventory(unrelated, contract)).toThrow(
      "unrelated schema",
    );
    await pg.exec(
      "DROP TABLE unrelated_customer_data; CREATE TABLE users(id text)",
    );
    expect(() =>
      validateInventory(
        {
          ...unrelated,
          relations: [
            {
              schema_name: "public",
              name: "users",
              kind: "r",
              columns: ["id"],
            },
          ],
          migrationNames: [],
        },
        contract,
      ),
    ).toThrow("core migration ledger");
    await pg.exec("DROP TABLE users");
  });
  it("recognizes the actual applied Tilwa SQL and refuses drift, unknown migrations or real tenants", async () => {
    for (const file of files) {
      await pg.exec(file.sql);
      await pg.query("INSERT INTO schema_migrations(name) VALUES($1)", [
        file.name,
      ]);
    }
    const inventory = await inspectInventory(sql);
    expect(validateInventory(inventory, contract)).toBe("tilwa");
    expect(() =>
      validateInventory(
        {
          ...inventory,
          migrationNames: [...inventory.migrationNames, "unrelated.sql"],
        },
        contract,
      ),
    ).toThrow("unrecognized migration");
    expect(() =>
      validateInventory(
        {
          ...inventory,
          relations: inventory.relations.filter((r) => r.name !== "records"),
        },
        contract,
      ),
    ).toThrow("missing a required table");
    expect(() =>
      validateInventory(
        {
          ...inventory,
          relations: inventory.relations.map((r) =>
            r.name === "records" ? { ...r, columns: ["id"] } : r,
          ),
        },
        contract,
      ),
    ).toThrow("expected Tilwa columns");
    await pg.query(
      "INSERT INTO tenants(id,name,synthetic) VALUES('live-fixture','Not a synthetic tenant',false)",
    );
    expect(() =>
      validateInventory({ ...inventory, nonSyntheticTenants: true }, contract),
    ).toThrow("non-synthetic");
    expect((await inspectInventory(sql)).nonSyntheticTenants).toBe(true);
  });
  it("creates only Preview variable entries and leaves Production-only values untouched", () => {
    const result = previewVariablePlan(
      [{ id: "prod-id", key: "DATABASE_URL", target: ["production"] }],
      { DATABASE_URL: "runtime-fixture" },
    );
    expect(result).toEqual([
      {
        id: undefined,
        body: {
          key: "DATABASE_URL",
          value: "runtime-fixture",
          type: "encrypted",
          target: ["preview"],
        },
      },
    ]);
    expect(
      previewVariablePlan(
        [{ id: "preview-id", key: "SESSION_SECRET", target: ["preview"] }],
        { SESSION_SECRET: "fixture" },
      )[0].id,
    ).toBe("preview-id");
  });
  it("adds a feature-branch Preview override without changing a shared Production variable", () => {
    const original = {
      id: "shared",
      key: "DATABASE_URL",
      target: ["production", "preview"],
    };
    const branch = "feat/tilwa-pilot-v1";
    const result = previewVariablePlan(
      [original],
      { DATABASE_URL: "runtime-fixture" },
      branch,
    );
    expect(result).toEqual([
      {
        id: undefined,
        body: {
          key: "DATABASE_URL",
          value: "runtime-fixture",
          type: "encrypted",
          target: ["preview"],
          gitBranch: branch,
        },
      },
    ]);
    expect(original.target).toEqual(["production", "preview"]);
    expect(
      previewVariablePlan(
        [
          {
            id: "ours",
            key: "DATABASE_URL",
            target: ["preview"],
            gitBranch: branch,
          },
        ],
        { DATABASE_URL: "new-fixture" },
        branch,
      )[0].id,
    ).toBe("ours");
    expect(
      previewVariablePlan(
        [
          {
            id: "other",
            key: "DATABASE_URL",
            target: ["preview"],
            gitBranch: "feat/other",
          },
        ],
        { DATABASE_URL: "fixture" },
        branch,
      )[0].id,
    ).toBeUndefined();
    expect(() => previewVariablePlan([], {}, "invalid branch")).toThrow(
      "Invalid Preview branch",
    );
  });
  it("uses keys from the selected branch or default Preview scope, never another branch", () => {
    const branch = "feat/tilwa-pilot-v1";
    expect(
      previewGeminiSetting(
        [
          {
            id: "g",
            key: "GEMINI_API_KEY",
            target: ["preview"],
            gitBranch: branch,
          },
        ],
        undefined,
        branch,
      ),
    ).toEqual({});
    expect(() =>
      previewGeminiSetting(
        [
          {
            id: "g",
            key: "GEMINI_API_KEY",
            target: ["preview"],
            gitBranch: "feat/other",
          },
        ],
        undefined,
        branch,
      ),
    ).toThrow("encrypted Preview settings");
    expect(
      previewSessionSetting(
        [
          {
            id: "s",
            key: "SESSION_SECRET",
            target: ["preview"],
            gitBranch: "feat/other",
          },
        ],
        undefined,
        branch,
      ).SESSION_SECRET.length,
    ).toBeGreaterThanOrEqual(32);
  });
  it("refuses shared Production/Preview variables or branch overrides before changing any value", () => {
    expect(() =>
      previewVariablePlan(
        [
          {
            id: "shared",
            key: "DATABASE_URL",
            target: ["production", "preview"],
          },
        ],
        { DATABASE_URL: "fixture" },
      ),
    ).toThrow("shares other targets");
    expect(() =>
      previewVariablePlan(
        [
          {
            id: "branch",
            key: "DATABASE_URL",
            target: ["preview"],
            gitBranch: "other-branch",
          },
        ],
        { DATABASE_URL: "fixture" },
      ),
    ).toThrow("branch override");
    expect(() =>
      previewVariablePlan(
        [
          { id: "a", key: "DATABASE_URL", target: ["preview"] },
          { id: "b", key: "DATABASE_URL", target: ["preview"] },
        ],
        { DATABASE_URL: "fixture" },
      ),
    ).toThrow("ambiguous");
  });
});
