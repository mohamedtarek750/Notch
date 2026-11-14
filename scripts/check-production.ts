/** Reproducible actual production-build browser test on explicitly LOCAL PostgreSQL. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
if (process.env.VERCEL)
  throw new Error(
    "Local production-build verification is not a deployment command.",
  );
await mkdir(".tilwa-private", { recursive: true, mode: 0o700 });
const databasePath = await mkdtemp(".tilwa-private/production-check-");
const port = "3100";
const env = {
  ...process.env,
  LOCAL_DATABASE: "1",
  LOCAL_DATABASE_PATH: databasePath,
  DEMO_MODE: "true",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  TILWA_ENV: "local-verification",
  PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}`,
};
async function run(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, args, { env, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Verification process exited ${code}`)),
    );
  });
}
await run(["--import", "tsx", "scripts/migrate.ts"]);
// Browser sign-in creates independent synthetic workspaces using real persisted SQL.
let server: ChildProcess | undefined;
try {
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", port],
    { env, stdio: "inherit" },
  );
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(env.PLAYWRIGHT_BASE_URL, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error("Production server failed readiness.");
  await run(["node_modules/@playwright/test/cli.js", "test"]);
  console.log(
    "PASS: production Next.js server + LOCAL PostgreSQL browser journeys. This is NOT Neon/Gemini live validation.",
  );
} finally {
  server?.kill("SIGTERM");
}
