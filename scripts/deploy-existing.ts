/** Deploy only to explicitly selected, existing Neon and Vercel Preview resources. */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { Pool } from "pg";
import { GoogleGenAI } from "@google/genai";

type Env = Record<string, string | undefined>;
export function migrationConnection(env: Env): string | undefined {
  return (
    env.MIGRATION_DATABASE_URL ||
    env.DATABASE_URL_UNPOOLED ||
    env.POSTGRES_URL_NON_POOLING ||
    env.DATABASE_URL
  );
}
export class ExistingDeployError extends Error {}
export function existingDeploymentBlockers(env: Env): string[] {
  const missing = ["DATABASE_URL", "VERCEL_TOKEN", "GEMINI_API_KEY"].filter(
    (key) => !env[key],
  );
  const issues = missing.length
    ? [`Missing secure settings: ${missing.join(", ")}.`]
    : [];
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32)
    issues.push("SESSION_SECRET must contain at least 32 characters.");
  if (env.DEPLOY_EXISTING !== "1")
    issues.push(
      "Set DEPLOY_EXISTING=1 to deploy to the explicitly selected existing non-production database and project.",
    );
  if (!env.VERCEL_PROJECT_ID && !env.VERCEL_PROJECT_NAME)
    issues.push(
      "Specify VERCEL_PROJECT_ID or VERCEL_PROJECT_NAME. No project will be created.",
    );
  if (!env.VERCEL_ORG_ID && !env.VERCEL_TEAM_ID && !env.VERCEL_TEAM_SLUG)
    issues.push(
      "Specify the existing Vercel account/team using VERCEL_ORG_ID, VERCEL_TEAM_ID, or VERCEL_TEAM_SLUG.",
    );
  if (
    env.LOCAL_DATABASE === "1" ||
    env.TILWA_ENV === "production" ||
    env.VERCEL_ENV === "production"
  )
    issues.push(
      "Only real Neon resources explicitly selected for Preview are supported.",
    );
  for (const name of [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL_NON_POOLING",
  ]) {
    if (!env[name]) continue;
    try {
      databaseIdentity(env[name]!);
    } catch {
      issues.push(
        `${name} must be a valid TLS Neon PostgreSQL connection URL.`,
      );
    }
  }
  if (env.DATABASE_URL && migrationConnection(env)) {
    try {
      if (
        databaseIdentity(env.DATABASE_URL) !==
        databaseIdentity(migrationConnection(env)!)
      )
        issues.push(
          "Runtime and migration URLs must identify the same Neon branch endpoint and database.",
        );
    } catch {
      /* URL errors are already reported without exposing values. */
    }
  }
  return issues;
}
/** Compare an unpooled and pooled URL without returning credentials. */
export function databaseIdentity(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExistingDeployError("Invalid PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname.endsWith(".neon.tech") ||
    !url.username ||
    !url.password ||
    url.pathname.length < 2 ||
    (url.port && url.port !== "5432")
  )
    throw new ExistingDeployError(
      "Expected a TLS Neon PostgreSQL connection URL.",
    );
  const parts = url.hostname.toLowerCase().split(".");
  parts[0] = parts[0].replace(/-pooler$/, "");
  return `${parts.join(".")}${url.pathname}`;
}
export interface Sql {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface SchemaContract {
  files: string[];
  tables: Record<string, string>;
}
export function schemaContract(
  files: { name: string; sql: string }[],
): SchemaContract {
  const tables: Record<string, string> = {};
  for (const file of files)
    for (const match of file.sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*\(/gi,
    )) {
      const name = match[1].includes(".") ? match[1] : `public.${match[1]}`;
      tables[name] = file.name;
    }
  return { files: files.map((file) => file.name), tables };
}
export interface Inventory {
  relations: {
    schema_name: string;
    name: string;
    kind: string;
    columns: string[];
  }[];
  migrationNames: string[];
  routines: number;
  nonSyntheticTenants: boolean;
}
export function validateInventory(
  value: Inventory,
  contract: SchemaContract,
): "empty" | "tilwa" {
  if (value.routines)
    throw new ExistingDeployError(
      "The database contains application routines outside the Tilwa migration contract. No migration was run.",
    );
  if (value.nonSyntheticTenants)
    throw new ExistingDeployError(
      "The database contains non-synthetic tenants. Use the authorized pilot database.",
    );
  for (const relation of value.relations) {
    const key = `${relation.schema_name}.${relation.name}`;
    if (!["r", "p"].includes(relation.kind) || !contract.tables[key])
      throw new ExistingDeployError(
        "The database contains unrelated schema objects. No migration was run.",
      );
  }
  if (value.migrationNames.some((name) => !contract.files.includes(name)))
    throw new ExistingDeployError(
      "The database contains an unrecognized migration history.",
    );
  const ledger = value.relations.find(
    (relation) =>
      relation.schema_name === "public" &&
      relation.name === "schema_migrations",
  );
  if (
    ledger &&
    !["name", "applied_at"].every((column) => ledger.columns.includes(column))
  )
    throw new ExistingDeployError(
      "The migration ledger conflicts with the Tilwa schema.",
    );
  if (
    value.relations.some(
      (relation) =>
        !(
          relation.schema_name === "public" &&
          relation.name === "schema_migrations"
        ),
    ) &&
    !value.migrationNames.includes("001_core.sql")
  )
    throw new ExistingDeployError(
      "Existing table names overlap Tilwa but a matching core migration ledger is missing.",
    );
  for (const relation of value.relations) {
    const key = `${relation.schema_name}.${relation.name}`;
    if (
      key !== "public.schema_migrations" &&
      !value.migrationNames.includes(contract.tables[key])
    )
      throw new ExistingDeployError(
        "An existing table has no matching applied Tilwa migration.",
      );
  }
  for (const [key, migration] of Object.entries(contract.tables)) {
    if (
      value.migrationNames.includes(migration) &&
      !value.relations.some(
        (relation) => `${relation.schema_name}.${relation.name}` === key,
      )
    )
      throw new ExistingDeployError(
        "An applied Tilwa migration is missing a required table.",
      );
  }
  const signatures: Record<string, string[]> = {
    "public.tenants": ["id", "name", "synthetic"],
    "public.users": ["tenant_id", "id", "name"],
    "public.records": [
      "tenant_id",
      "id",
      "kind",
      "course_id",
      "owner_id",
      "data",
    ],
    "public.policy_versions": ["id", "version", "active", "data"],
  };
  for (const relation of value.relations) {
    const required = signatures[`${relation.schema_name}.${relation.name}`];
    if (
      required &&
      !required.every((column) => relation.columns.includes(column))
    )
      throw new ExistingDeployError(
        "An existing table conflicts with the expected Tilwa columns.",
      );
  }
  return value.migrationNames.length ? "tilwa" : "empty";
}
/** Caller provides a READ ONLY transaction; no data or secret values are returned. */
export async function inspectInventory(sql: Sql): Promise<Inventory> {
  const relations = (
    await sql.query<
      Inventory["relations"][number]
    >(`SELECT n.nspname AS schema_name, c.relname AS name, c.relkind::text AS kind,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','neon_auth') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
    AND c.relkind IN ('r','p','v','m','f') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') ORDER BY n.nspname,c.relname`)
  ).rows;
  const routines =
    (
      await sql.query<{
        count: number;
      }>(`SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','neon_auth') AND n.nspname NOT LIKE 'pg_%'
    AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`)
    ).rows[0]?.count ?? 0;
  let migrationNames: string[] = [];
  const ledger = relations.find(
    (relation) =>
      relation.schema_name === "public" &&
      relation.name === "schema_migrations",
  );
  if (ledger?.columns.includes("name"))
    migrationNames = (
      await sql.query<{ name: string }>(
        "SELECT name FROM public.schema_migrations ORDER BY name",
      )
    ).rows.map((row) => row.name);
  let nonSyntheticTenants = false;
  const tenants = relations.find(
    (relation) =>
      relation.schema_name === "public" && relation.name === "tenants",
  );
  if (tenants?.columns.includes("synthetic"))
    nonSyntheticTenants =
      (
        await sql.query(
          "SELECT 1 FROM public.tenants WHERE synthetic IS DISTINCT FROM true LIMIT 1",
        )
      ).rows.length > 0;
  return { relations, migrationNames, routines, nonSyntheticTenants };
}
export interface VercelVariable {
  id: string;
  key: string;
  target: string[];
  gitBranch?: string | null;
  customEnvironmentIds?: string[];
}
export function previewVariablePlan(
  existing: VercelVariable[],
  values: Record<string, string>,
  gitBranch?: string,
) {
  if (
    gitBranch &&
    (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(gitBranch) ||
      gitBranch.includes("..") ||
      gitBranch.endsWith("/"))
  )
    throw new ExistingDeployError("Invalid Preview branch identifier.");
  return Object.entries(values).map(([key, value]) => {
    const matches = existing.filter(
      (variable) =>
        variable.key === key &&
        variable.target?.includes("preview") &&
        (!gitBranch || variable.gitBranch === gitBranch),
    );
    if (
      matches.some(
        (variable) =>
          variable.target.some((target) => target !== "preview") ||
          (variable.gitBranch && variable.gitBranch !== gitBranch) ||
          variable.customEnvironmentIds?.length,
      )
    )
      throw new ExistingDeployError(
        `Preview variable ${key} shares other targets or has a branch override. Split its Preview configuration in Vercel settings before retrying; Production was not changed.`,
      );
    if (matches.length > 1)
      throw new ExistingDeployError(
        `Preview variable ${key} has ambiguous definitions.`,
      );
    return {
      id: matches[0]?.id,
      body: {
        key,
        value,
        type: "encrypted",
        target: ["preview"],
        ...(gitBranch ? { gitBranch } : {}),
      },
    };
  });
}
export function previewSessionSetting(
  existing: VercelVariable[],
  supplied?: string,
  gitBranch?: string,
): Record<string, string> {
  if (supplied) {
    if (supplied.length < 32)
      throw new ExistingDeployError(
        "SESSION_SECRET must contain at least 32 characters.",
      );
    return { SESSION_SECRET: supplied };
  }
  if (
    existing.some(
      (variable) =>
        variable.key === "SESSION_SECRET" &&
        variable.target?.includes("preview") &&
        (!variable.gitBranch || variable.gitBranch === gitBranch),
    )
  )
    return {};
  return { SESSION_SECRET: randomBytes(48).toString("base64url") };
}
/** Local cloud bindings may be placeholders: never forward GEMINI_API_KEY to Vercel. */
export function previewGeminiSetting(
  existing: VercelVariable[],
  rawPreviewKey?: string,
  gitBranch?: string,
): Record<string, string> {
  if (rawPreviewKey) return { GEMINI_API_KEY: rawPreviewKey };
  if (
    existing.some(
      (variable) =>
        variable.key === "GEMINI_API_KEY" &&
        variable.target?.includes("preview") &&
        (!variable.gitBranch || variable.gitBranch === gitBranch),
    )
  )
    return {};
  throw new ExistingDeployError(
    "The existing Vercel project needs GEMINI_API_KEY in its encrypted Preview settings, or an explicitly injected raw PREVIEW_GEMINI_API_KEY. The local proxy binding will not be copied.",
  );
}
export async function readCliToken(
  configDirectory: string,
): Promise<string | undefined> {
  try {
    const auth = JSON.parse(
      await readFile(resolve(configDirectory, "auth.json"), "utf8"),
    ) as { token?: unknown };
    return typeof auth.token === "string" && auth.token.length > 0
      ? auth.token
      : undefined;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw new ExistingDeployError(
      "The existing Vercel CLI login could not be read. Complete the CLI login in its private config directory.",
    );
  }
}
function poolFor(value: string): Pool {
  databaseIdentity(value);
  const url = new URL(value);
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(name);
  return new Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
    max: 1,
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
  });
}
function safeEnv(env: Env, extra: Env): NodeJS.ProcessEnv {
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}
async function run(args: string[], env: Env, phase: string): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new ExistingDeployError(
          `${phase} timed out; inspect the existing project before retrying.`,
        ),
      );
    }, 900000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 1000000) output += chunk.toString();
    });
    child.stderr.on("data", () => {
      /* Raw diagnostics could contain credentials. */
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new ExistingDeployError(`${phase} could not start.`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(output);
      else
        reject(
          new ExistingDeployError(
            `${phase} failed with exit ${code}; no credentials were printed.`,
          ),
        );
    });
  });
}
async function requestVercel<T>(
  path: string,
  token: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  body?: unknown,
): Promise<T> {
  // A hard boundary: this runner can write only environment variables of an existing project.
  if (
    method !== "GET" &&
    !/^\/v(?:9|10)\/projects\/[^/]+\/env(?:\/[^/?]+)?\?/.test(path)
  )
    throw new ExistingDeployError(
      "Only existing-project Preview variable writes are supported.",
    );
  let response: Response;
  try {
    response = await fetch(`https://api.vercel.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ExistingDeployError(
      "Vercel API connectivity failed. Check network access and the injected token.",
    );
  }
  if (!response.ok)
    throw new ExistingDeployError(
      `Vercel API returned HTTP ${response.status}. Check access to the selected existing project; no duplicate project will be created.`,
    );
  return response.json() as Promise<T>;
}
export async function runtimeReady(uri: string): Promise<boolean> {
  const pool = poolFor(uri);
  try {
    const role = (
      await pool.query<{
        elevated: boolean;
        owner: boolean;
      }>(`SELECT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb) AS elevated,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','demo_sis') AND c.relkind='r' AND pg_has_role(current_user,c.relowner,'MEMBER')) AS owner
      FROM pg_roles WHERE rolname=current_user`)
    ).rows[0];
    if (!role || role.elevated || role.owner) return false;
    const unsafe =
      await pool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','demo_sis') AND c.relkind='r'
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND a.attnum>0)
      AND NOT(c.relrowsecurity AND c.relforcerowsecurity)`);
    if (unsafe.rowCount) return false;
    const rows = await pool.query("SELECT id FROM public.records LIMIT 1");
    return !rows.rowCount;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}
export async function chooseRuntime(
  migrationUri: string,
  requestedUri: string,
  projectId: string,
) {
  const pooled = new URL(requestedUri);
  const labels = pooled.hostname.split(".");
  if (!labels[0].endsWith("-pooler")) labels[0] += "-pooler";
  pooled.hostname = labels.join(".");
  pooled.searchParams.set("sslmode", "verify-full");
  if (await runtimeReady(pooled.toString()))
    return { uri: pooled.toString(), roleCreated: false };
  // Do not rotate an existing role/password used by an earlier deployment or any Production service.
  const roleName = `tilwa_preview_${createHash("sha256").update(projectId).digest("hex").slice(0, 8)}_${randomBytes(5).toString("hex")}`;
  const password = randomBytes(36).toString("base64url");
  const pool = poolFor(migrationUri);
  try {
    const sql = (
      await pool.query<{ statement: string }>(
        "SELECT format('CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',$1::text,$2::text) AS statement",
        [roleName, password],
      )
    ).rows[0].statement;
    await pool.query(sql);
    const grant = (
      await pool.query<{ statement: string }>(
        "SELECT format('GRANT tilwa_runtime TO %I',$1::text) AS statement",
        [roleName],
      )
    ).rows[0].statement;
    await pool.query(grant);
  } catch {
    throw new ExistingDeployError(
      "Creating a separate non-owner Preview login failed. Supply MIGRATION_DATABASE_URL with role-management rights, or an already verified pooled DATABASE_URL. Existing logins were not changed.",
    );
  } finally {
    await pool.end();
  }
  pooled.username = roleName;
  pooled.password = password;
  if (!(await runtimeReady(pooled.toString())))
    throw new ExistingDeployError(
      "The new pooled Preview login failed non-owner/RLS validation. Deployment stopped.",
    );
  return { uri: pooled.toString(), roleCreated: true };
}
interface Project {
  id: string;
  name: string;
  accountId: string;
  framework?: string | null;
  rootDirectory?: string | null;
}
async function main() {
  const cliConfig = resolve(".tilwa-private/vercel-cli");
  let token = process.env.VERCEL_TOKEN || (await readCliToken(cliConfig));
  const problems = existingDeploymentBlockers({
    ...process.env,
    VERCEL_TOKEN: token,
  });
  if (problems.length) {
    problems.forEach((problem) => console.error(`BLOCKED: ${problem}`));
    process.exitCode = 2;
    return;
  }
  if (typeof http.setGlobalProxyFromEnv === "function")
    http.setGlobalProxyFromEnv();
  const env = process.env;
  let currentBranch: string;
  try {
    currentBranch = execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new ExistingDeployError(
      "Cannot determine the current feature branch.",
    );
  }
  const previewBranch = env.VERCEL_PREVIEW_BRANCH || currentBranch;
  if (!previewBranch || previewBranch !== currentBranch)
    throw new ExistingDeployError(
      "Preview overrides must match the current checked-out feature branch.",
    );
  if (!env.VERCEL_TOKEN && token) {
    // Let the CLI refresh its own OAuth login; never expose or copy refresh credentials.
    await run(
      [
        "node_modules/vercel/dist/vc.js",
        "whoami",
        "--global-config",
        cliConfig,
      ],
      safeEnv(env, { VERCEL_TELEMETRY_DISABLED: "1" }),
      "Vercel CLI session verification",
    );
    token = await readCliToken(cliConfig);
  }
  if (!token)
    throw new ExistingDeployError(
      "Complete Vercel CLI login or inject VERCEL_TOKEN securely.",
    );
  const scope = new URLSearchParams();
  const teamId =
    env.VERCEL_TEAM_ID ||
    (env.VERCEL_ORG_ID?.startsWith("team_") ? env.VERCEL_ORG_ID : undefined);
  if (teamId) scope.set("teamId", teamId);
  else if (env.VERCEL_TEAM_SLUG) scope.set("slug", env.VERCEL_TEAM_SLUG);
  const projectSelector = env.VERCEL_PROJECT_ID || env.VERCEL_PROJECT_NAME!;
  const project = await requestVercel<Project>(
    `/v9/projects/${encodeURIComponent(projectSelector)}?${scope}`,
    token,
  );
  if (
    !project.id ||
    !project.accountId ||
    (env.VERCEL_PROJECT_ID && project.id !== env.VERCEL_PROJECT_ID) ||
    (env.VERCEL_ORG_ID && project.accountId !== env.VERCEL_ORG_ID) ||
    (env.VERCEL_PROJECT_NAME && project.name !== env.VERCEL_PROJECT_NAME)
  )
    throw new ExistingDeployError(
      "The existing Vercel project does not match the explicit identifiers.",
    );
  if (project.rootDirectory && project.rootDirectory !== ".")
    throw new ExistingDeployError(
      "The existing project uses a different root directory. Confirm its repository settings before deploying.",
    );
  if (project.framework && project.framework !== "nextjs")
    throw new ExistingDeployError(
      "The existing project has a different framework setting. Select Next.js in that project before retrying.",
    );
  try {
    const linked = JSON.parse(
      await readFile(".vercel/project.json", "utf8"),
    ) as { projectId?: string; orgId?: string };
    if (linked.projectId !== project.id || linked.orgId !== project.accountId)
      throw new ExistingDeployError(
        "The local checkout is linked to another Vercel project. Preserve that link and deliberately relink to the selected project.",
      );
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const variables = await requestVercel<{ envs: VercelVariable[] }>(
    `/v9/projects/${encodeURIComponent(project.id)}/env?${scope}`,
    token,
  );
  const requiredPreviewKeys: Record<string, string> = {
    DATABASE_URL: "",
    GEMINI_MODEL: "",
    SESSION_SECRET: "",
    DEMO_MODE: "",
    TILWA_ENV: "",
    LOCAL_DATABASE: "",
  };
  if (
    !env.SESSION_SECRET &&
    variables.envs.some(
      (variable) =>
        variable.key === "SESSION_SECRET" &&
        variable.target?.includes("preview") &&
        (!variable.gitBranch || variable.gitBranch === previewBranch),
    )
  )
    delete requiredPreviewKeys.SESSION_SECRET;
  const geminiPreviewValues = previewGeminiSetting(
    variables.envs,
    env.PREVIEW_GEMINI_API_KEY,
    previewBranch,
  );
  if (geminiPreviewValues.GEMINI_API_KEY)
    requiredPreviewKeys.GEMINI_API_KEY = "";
  previewVariablePlan(variables.envs, requiredPreviewKeys, previewBranch);
  const migrationUri = migrationConnection(env)!;
  const contractFiles = (await readdir("migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const contract = schemaContract(
    await Promise.all(
      contractFiles.map(async (name) => ({
        name,
        sql: await readFile(`migrations/${name}`, "utf8"),
      })),
    ),
  );
  const owner = poolFor(migrationUri);
  let inventoryStatus: "empty" | "tilwa";
  try {
    const client = await owner.connect();
    try {
      await client.query("BEGIN READ ONLY");
      inventoryStatus = validateInventory(
        await inspectInventory(client),
        contract,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof ExistingDeployError) throw error;
    throw new ExistingDeployError(
      "Read-only Neon inventory failed. Check credentials, TLS and PostgreSQL network access; no migration was run.",
    );
  } finally {
    await owner.end();
  }
  let modelId: string;
  try {
    const client = new GoogleGenAI({
      apiKey: env.PREVIEW_GEMINI_API_KEY || env.GEMINI_API_KEY!,
      httpOptions: { timeout: 20000 },
    });
    const requested = env.GEMINI_MODEL || "gemini-2.5-flash";
    const model = await client.models.get({ model: requested });
    modelId = (model.name || requested).replace(/^models\//, "");
  } catch {
    throw new ExistingDeployError(
      "Gemini model verification failed. Check the injected raw key, selected stable model and provider network access. No migration was run.",
    );
  }
  const baseEnv = safeEnv(env, {
    LOCAL_DATABASE: "0",
    TILWA_ENV: "preview",
    DEMO_MODE: "true",
    GEMINI_MODEL: modelId,
  });
  console.log(
    JSON.stringify({
      stage: "preflight-passed",
      inventory: inventoryStatus,
      existingProject: project.name,
      target: "preview",
      modelId,
    }),
  );
  await run(
    ["--import", "tsx", "scripts/migrate.ts"],
    {
      ...baseEnv,
      DATABASE_URL: migrationUri,
      MIGRATION_DATABASE_URL: migrationUri,
    },
    "Existing database migrations",
  );
  const runtime = await chooseRuntime(
    migrationUri,
    env.DATABASE_URL!,
    project.id,
  );
  await run(
    ["--import", "tsx", "scripts/seed.ts"],
    {
      ...baseEnv,
      DATABASE_URL: runtime.uri,
      MIGRATION_DATABASE_URL: undefined,
    },
    "Synthetic demo seed",
  );
  const values: Record<string, string> = {
    DATABASE_URL: runtime.uri,
    GEMINI_MODEL: modelId,
    DEMO_MODE: "true",
    TILWA_ENV: "preview",
    LOCAL_DATABASE: "0",
  };
  Object.assign(values, geminiPreviewValues);
  Object.assign(
    values,
    previewSessionSetting(variables.envs, env.SESSION_SECRET, previewBranch),
  );
  for (const change of previewVariablePlan(
    variables.envs,
    values,
    previewBranch,
  )) {
    const endpoint = change.id
      ? `/v9/projects/${encodeURIComponent(project.id)}/env/${encodeURIComponent(change.id)}?${scope}`
      : `/v10/projects/${encodeURIComponent(project.id)}/env?${scope}`;
    await requestVercel(
      endpoint,
      token,
      change.id ? "PATCH" : "POST",
      change.body,
    );
  }
  await mkdir(".vercel", { recursive: true });
  await writeFile(
    ".vercel/project.json",
    JSON.stringify({
      projectId: project.id,
      orgId: project.accountId,
      projectName: project.name,
    }),
    { mode: 0o600 },
  );
  await mkdir(cliConfig, { recursive: true, mode: 0o700 });
  const output = await run(
    [
      "node_modules/vercel/dist/vc.js",
      "deploy",
      "--yes",
      "--target",
      "preview",
      "--global-config",
      cliConfig,
    ],
    safeEnv(baseEnv, {
      VERCEL_TOKEN: token,
      VERCEL_PROJECT_ID: project.id,
      VERCEL_ORG_ID: project.accountId,
      VERCEL_TELEMETRY_DISABLED: "1",
      DATABASE_URL: runtime.uri,
      MIGRATION_DATABASE_URL: undefined,
    }),
    "Existing Vercel Preview deployment",
  );
  const urls = output.match(/https:\/\/[a-z0-9-]+\.vercel\.app\b/gi);
  if (!urls?.length)
    throw new ExistingDeployError(
      "Deployment completed without a parseable Preview URL. Inspect the existing Vercel project rather than creating another project.",
    );
  const receipt = {
    status: "deployed",
    target: "preview",
    projectId: project.id,
    projectName: project.name,
    gitBranch: previewBranch,
    modelId,
    url: urls.at(-1),
    runtimeRoleCreated: runtime.roleCreated,
    sourceAcceptance: "not_yet_verified",
    liveAcceptance: "not_yet_verified",
  };
  // Only non-secret identifiers and outcomes are persisted. No DSN, password, key or token is written.
  await writeFile(
    ".tilwa-private/existing-preview-receipt.json",
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(receipt, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    console.error(
      `BLOCKED: ${error instanceof ExistingDeployError ? error.message : "Existing-resource deployment failed. Provider diagnostics were suppressed to protect secret values."}`,
    );
    process.exitCode = 1;
  });
