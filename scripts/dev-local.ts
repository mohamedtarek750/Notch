/** Explicit offline PostgreSQL development. Never used in a deployed application. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
if (process.env.VERCEL)
  throw new Error("Local database mode cannot run on Vercel.");
await mkdir(".tilwa-private", { recursive: true, mode: 0o700 });
let secret: string;
try {
  secret = await readFile(".tilwa-private/session-secret", "utf8");
} catch {
  secret = randomBytes(48).toString("base64url");
  await writeFile(".tilwa-private/session-secret", secret, { mode: 0o600 });
}
const env = {
  ...process.env,
  LOCAL_DATABASE: "1",
  DEMO_MODE: "true",
  SESSION_SECRET: secret,
};
async function run(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Local setup failed")),
    );
    child.on("error", reject);
  });
}
await run(["--import", "tsx", "scripts/migrate.ts"]);
await run(["--import", "tsx", "scripts/seed.ts"]);
console.log(
  "LOCAL PostgreSQL (PGlite) development. Neon and Gemini live checks require provider settings.",
);
await run([
  "node_modules/next/dist/bin/next",
  "dev",
  "--hostname",
  "0.0.0.0",
  "--webpack",
]);
