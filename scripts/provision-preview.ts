/** Opt-in NON-PRODUCTION provisioning. Run only with raw server credentials, not proxy placeholders. */
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import * as http from "node:http";
import { GoogleGenAI } from "@google/genai";

type Env = Record<string, string | undefined>;
export function provisioningBlockers(env: Env): string[] {
  const absent = ["NEON_API_KEY", "VERCEL_TOKEN", "GEMINI_API_KEY"].filter(
    (k) => !env[k],
  );
  const blockers = absent.length
    ? [`Configure ${absent.join(", ")} in secure environment settings.`]
    : [];
  if (env.PROVISION_PREVIEW !== "1")
    blockers.push(
      "Set PROVISION_PREVIEW=1 to create isolated non-production resources.",
    );
  if (env.TILWA_ENV === "production" || env.VERCEL_ENV === "production")
    blockers.push("This runner cannot operate in a production environment.");
  return blockers;
}
interface Receipt {
  version: 1;
  name: string;
  neonProjectId?: string;
  neonBranchId?: string;
  vercelProjectId?: string;
  vercelOrgId?: string;
  modelId?: string;
  previewUrl?: string;
  stage?: string;
}
interface PrivateState {
  runtimePassword: string;
  sessionSecret: string;
}
const receiptPath = ".tilwa-private/provisioning.json";
const privatePath = ".tilwa-private/provisioning-secrets.json";
const neonBase = "https://console.neon.tech/api/v2";
const vercelBase = "https://api.vercel.com";
class ProvisionError extends Error {}
async function call<T>(
  base: string,
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ProvisionError(
      `Network request failed for ${new URL(base).hostname}; check the environment allowlist and proxy configuration.`,
    );
  }
  // Provider response text and credential-bearing URIs are deliberately never included in errors.
  if (!response.ok)
    throw new ProvisionError(
      `Provider HTTP ${response.status} at ${new URL(base).hostname}. Check account permissions and quota; no upgrade was requested.`,
    );
  return response.json() as Promise<T>;
}
async function saveReceipt(receipt: Receipt) {
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
  await chmod(receiptPath, 0o600);
}
async function readOptional<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw new ProvisionError(
      `Cannot read local provisioning state ${file}. Preserve it and repair it before retrying.`,
    );
  }
}
async function run(
  command: string,
  args: string[],
  env: Env,
  phase: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env as NodeJS.ProcessEnv,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new ProvisionError(
          `${phase} exceeded 15 minutes. Retry using the saved provisioning receipt.`,
        ),
      );
    }, 900000);
    // Capture rather than print subprocess errors, which might contain DSNs or SQL passwords.
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes < 1000000) output += chunk.toString();
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new ProvisionError(`${phase} could not start.`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else
        reject(
          new ProvisionError(
            `${phase} failed (exit ${code}). Existing resource IDs remain in ${receiptPath}; use documented manual checks.`,
          ),
        );
    });
  });
}
function poolFor(uri: string): Pool {
  const url = new URL(uri);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:")
    throw new ProvisionError("Provider returned an invalid PostgreSQL URL.");
  if (!url.hostname.endsWith(".neon.tech"))
    throw new ProvisionError("Expected an isolated Neon database endpoint.");
  for (const param of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(param);
  return new Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 15000,
  });
}
async function waitForDb(uri: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const pool = poolFor(uri);
    try {
      await pool.query("SELECT 1");
      return;
    } catch {
      if (attempt === 5)
        throw new ProvisionError(
          "Neon SQL connection is unavailable. Check TCP access, CA trust and branch readiness.",
        );
    } finally {
      await pool.end();
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
async function ensureRuntime(
  ownerUri: string,
  password: string,
): Promise<string> {
  const pool = poolFor(ownerUri);
  try {
    const exists = await pool.query(
      "SELECT rolname FROM pg_roles WHERE rolname='tilwa_app'",
    );
    // PostgreSQL utility commands do not bind parameters, so PostgreSQL itself quotes the password.
    const quoted = await pool.query<{ sql: string }>(
      "SELECT format($1,$2) AS sql",
      [
        exists.rowCount
          ? "ALTER ROLE tilwa_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT PASSWORD %L"
          : "CREATE ROLE tilwa_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT PASSWORD %L",
        password,
      ],
    );
    await pool.query(quoted.rows[0].sql);
    await pool.query("GRANT tilwa_runtime TO tilwa_app");
  } catch {
    throw new ProvisionError(
      "Least-privilege PostgreSQL login provisioning failed. The migration connection needs role-management privileges.",
    );
  } finally {
    await pool.end();
  }
  const runtime = new URL(ownerUri);
  runtime.username = "tilwa_app";
  runtime.password = password;
  const host = runtime.hostname.split(".");
  if (!host[0].endsWith("-pooler")) host[0] += "-pooler";
  runtime.hostname = host.join(".");
  runtime.searchParams.set("sslmode", "verify-full");
  const check = poolFor(runtime.toString());
  try {
    const roles = await check.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      owner: boolean;
    }>(
      `SELECT r.rolsuper,r.rolbypassrls,pg_has_role(current_user,c.relowner,'MEMBER') AS owner FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.records'::regclass`,
    );
    if (
      !roles.rows[0] ||
      roles.rows[0].rolsuper ||
      roles.rows[0].rolbypassrls ||
      roles.rows[0].owner
    )
      throw new Error("unsafe role");
    const visible = await check.query("SELECT id FROM records LIMIT 1");
    if (visible.rowCount) throw new Error("RLS not enforced");
  } catch {
    throw new ProvisionError(
      "The pooled runtime connection failed its non-owner/RLS check. Deployment stopped.",
    );
  } finally {
    await check.end();
  }
  return runtime.toString();
}
async function main() {
  const blockers = provisioningBlockers(process.env);
  if (blockers.length) {
    for (const text of blockers) console.error(`BLOCKED: ${text}`);
    process.exitCode = 2;
    return;
  }
  if (typeof http.setGlobalProxyFromEnv === "function")
    http.setGlobalProxyFromEnv();
  const neonToken = process.env.NEON_API_KEY!,
    vercelToken = process.env.VERCEL_TOKEN!;
  await mkdir(".tilwa-private", { recursive: true, mode: 0o700 });
  let receipt = await readOptional<Receipt>(receiptPath);
  if (!receipt) {
    receipt = {
      version: 1,
      name: `tilwa-pilot-${randomBytes(5).toString("hex")}`,
    };
    await saveReceipt(receipt);
  }
  if (receipt.version !== 1 || !/^tilwa-pilot-[a-z0-9-]+$/.test(receipt.name))
    throw new ProvisionError(
      "Unrecognized provisioning receipt. Do not replace existing project state.",
    );
  let privateState = await readOptional<PrivateState>(privatePath);
  if (!privateState && receipt.neonProjectId)
    throw new ProvisionError(
      "The private credential state is missing for existing resources. Restore it before resuming to avoid changing deployed credentials.",
    );
  if (!privateState) {
    privateState = {
      runtimePassword: randomBytes(32).toString("base64url"),
      sessionSecret: randomBytes(48).toString("base64url"),
    };
    await writeFile(privatePath, JSON.stringify(privateState), { mode: 0o600 });
  }
  await chmod(privatePath, 0o600);
  // Fix the model ID before any deployment. A requested stable model must exist in this project.
  const requestedModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  try {
    const client = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY!,
      httpOptions: { timeout: 20000 },
    });
    const model = await client.models.get({ model: requestedModel });
    receipt.modelId = (model.name || requestedModel).replace(/^models\//, "");
  } catch {
    throw new ProvisionError(
      "Gemini model lookup failed. Check GEMINI_API_KEY, GEMINI_MODEL and Google API network access.",
    );
  }
  await saveReceipt(receipt);
  if (!receipt.neonProjectId) {
    // Recover a successful create whose response was interrupted, using the persisted unique name.
    const listed = await call<{ projects: { id: string; name: string }[] }>(
      neonBase,
      "/projects",
      neonToken,
    );
    const matches = listed.projects.filter((p) => p.name === receipt!.name);
    if (matches.length > 1)
      throw new ProvisionError(
        "Multiple Neon projects match the receipt; resolve the duplicate before continuing.",
      );
    if (matches[0]) receipt.neonProjectId = matches[0].id;
    else {
      const created = await call<{
        project: { id: string };
        branches?: { id: string; name: string }[];
      }>(neonBase, "/projects", neonToken, "POST", {
        project: {
          name: receipt.name,
          pg_version: 17,
          region_id: process.env.NEON_REGION || "aws-us-east-1",
          branch: {
            name: "tilwa-preview",
            database_name: "tilwa",
            role_name: "tilwa_owner",
          },
          default_endpoint_settings: {
            autoscaling_limit_min_cu: 0.25,
            autoscaling_limit_max_cu: 0.25,
            suspend_timeout_seconds: 300,
          },
        },
      });
      receipt.neonProjectId = created.project.id;
      receipt.neonBranchId = created.branches?.find(
        (b) => b.name === "tilwa-preview",
      )?.id;
    }
    receipt.stage = "neon-created";
    await saveReceipt(receipt);
  }
  if (!receipt.neonBranchId) {
    const branches = await call<{ branches: { id: string; name: string }[] }>(
      neonBase,
      `/projects/${encodeURIComponent(receipt.neonProjectId)}/branches`,
      neonToken,
    );
    receipt.neonBranchId = branches.branches.find(
      (b) => b.name === "tilwa-preview",
    )?.id;
    if (!receipt.neonBranchId)
      throw new ProvisionError(
        "The isolated tilwa-preview Neon branch was not found.",
      );
    await saveReceipt(receipt);
  }
  const params = new URLSearchParams({
    branch_id: receipt.neonBranchId,
    database_name: "tilwa",
    role_name: "tilwa_owner",
    pooled: "false",
  });
  const owner = await call<{ uri: string }>(
    neonBase,
    `/projects/${encodeURIComponent(receipt.neonProjectId)}/connection_uri?${params}`,
    neonToken,
  );
  if (!owner.uri)
    throw new ProvisionError("Neon did not return a migration connection.");
  await waitForDb(owner.uri);
  const baseEnv = {
    ...process.env,
    LOCAL_DATABASE: "0",
    TILWA_ENV: "preview",
    DEMO_MODE: "true",
    GEMINI_MODEL: receipt.modelId,
    SESSION_SECRET: privateState.sessionSecret,
  };
  await run(
    process.execPath,
    ["--import", "tsx", "scripts/migrate.ts"],
    { ...baseEnv, DATABASE_URL: owner.uri, MIGRATION_DATABASE_URL: owner.uri },
    "Database migration",
  );
  const runtimeUri = await ensureRuntime(
    owner.uri,
    privateState.runtimePassword,
  );
  await run(
    process.execPath,
    ["--import", "tsx", "scripts/seed.ts"],
    { ...baseEnv, DATABASE_URL: runtimeUri },
    "Synthetic demo seed",
  );
  receipt.stage = "database-ready";
  await saveReceipt(receipt);
  const team = process.env.VERCEL_TEAM_ID;
  const teamQuery = team ? `?teamId=${encodeURIComponent(team)}` : "";
  if (!receipt.vercelProjectId) {
    const listed = await call<{
      projects: { id: string; name: string; accountId: string }[];
    }>(vercelBase, `/v9/projects${teamQuery}`, vercelToken);
    const existing = listed.projects.find((p) => p.name === receipt!.name);
    const project =
      existing ??
      (await call<{ id: string; name: string; accountId: string }>(
        vercelBase,
        `/v11/projects${teamQuery}`,
        vercelToken,
        "POST",
        { name: receipt.name, framework: "nextjs" },
      ));
    receipt.vercelProjectId = project.id;
    receipt.vercelOrgId = project.accountId;
    if (!receipt.vercelOrgId)
      throw new ProvisionError(
        "Vercel project account was not returned; retrieve its accountId before continuing.",
      );
    receipt.stage = "vercel-created";
    await saveReceipt(receipt);
  }
  const previewEnv: Record<string, string> = {
    DATABASE_URL: runtimeUri,
    GEMINI_API_KEY:
      process.env.PREVIEW_GEMINI_API_KEY || process.env.GEMINI_API_KEY!,
    GEMINI_MODEL: receipt.modelId!,
    SESSION_SECRET: privateState.sessionSecret,
    DEMO_MODE: "true",
    TILWA_ENV: "preview",
    LOCAL_DATABASE: "0",
  };
  await call(
    vercelBase,
    `/v10/projects/${encodeURIComponent(receipt.vercelProjectId)}/env?upsert=true${team ? `&teamId=${encodeURIComponent(team)}` : ""}`,
    vercelToken,
    "POST",
    Object.entries(previewEnv).map(([key, value]) => ({
      key,
      value,
      type: "encrypted",
      target: ["preview"],
    })),
  );
  await mkdir(".vercel", { recursive: true });
  await writeFile(
    ".vercel/project.json",
    JSON.stringify({
      projectId: receipt.vercelProjectId,
      orgId: receipt.vercelOrgId,
      projectName: receipt.name,
    }),
    { mode: 0o600 },
  );
  // Private local configuration supports reproducible live tests. Never commit or print this file.
  await writeFile(
    ".env.preview.local",
    Object.entries({ ...previewEnv, MIGRATION_DATABASE_URL: owner.uri })
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  await chmod(".env.preview.local", 0o600);
  receipt.stage = "preview-environment-configured";
  await saveReceipt(receipt);
  const output = await run(
    process.execPath,
    [
      "node_modules/vercel/dist/vc.js",
      "deploy",
      "--yes",
      "--target",
      "preview",
    ],
    {
      ...process.env,
      VERCEL_TOKEN: vercelToken,
      VERCEL_PROJECT_ID: receipt.vercelProjectId,
      VERCEL_ORG_ID: receipt.vercelOrgId,
      VERCEL_TELEMETRY_DISABLED: "1",
    },
    "Vercel Preview deployment",
  );
  const urls = output.match(/https:\/\/[a-z0-9-]+\.vercel\.app\b/gi);
  if (!urls?.length)
    throw new ProvisionError(
      "Deployment command finished but no Preview URL was found. Inspect the saved Vercel project before deploying again.",
    );
  receipt.previewUrl = urls[urls.length - 1];
  receipt.stage = "preview-deployed";
  await saveReceipt(receipt);
  console.log(
    JSON.stringify(
      {
        status: "deployed",
        target: "preview",
        url: receipt.previewUrl,
        model: receipt.modelId,
        neonProjectId: receipt.neonProjectId,
        vercelProjectId: receipt.vercelProjectId,
        liveJourney: "not_yet_validated",
        next: "Import and review real CET351 sources in the Preview, then run test:live with LIVE_BASE_URL.",
      },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error) => {
    console.error(
      `BLOCKED: ${error instanceof ProvisionError ? error.message : "Provisioning failed. No credentials were printed. Inspect the current phase and provider resource IDs in the private receipt."}`,
    );
    process.exitCode = 1;
  });
}
