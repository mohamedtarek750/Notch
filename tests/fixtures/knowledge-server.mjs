// Isolate browser runs from developer and hosted databases.
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
const env = {
  ...process.env,
  DATABASE_URL: "",
  VERCEL: "",
  DEMO_MODE: "true",
  LOCAL_DATABASE: "1",
  LOCAL_DATABASE_PATH: mkdtempSync(join(tmpdir(), "notch-km-")),
  SESSION_SECRET: randomBytes(40).toString("hex"),
  GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:43919",
  GEMINI_API_KEY: "fixture",
  GEMINI_MODEL: "gemini-3.5-flash-lite",
};
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "scripts/migrate.ts"],
  { env, stdio: "inherit" },
);
if (result.status !== 0) process.exit(1);
spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    process.env.KM_TEST_PORT || "3124",
  ],
  { env, stdio: "inherit" },
);
