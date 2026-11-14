import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWorkspace } from "../src/server/seed";
import { db } from "../src/server/db";
async function main() {
  try {
    let code = process.env.DEMO_WORKSPACE_CODE;
    if (!code) {
      try {
        code = (
          await readFile(".tilwa-private/demo-workspace-code", "utf8")
        ).trim();
      } catch {
        /* A new independent demo workspace is created. */
      }
    }
    const workspace = await createWorkspace(code);
    await mkdir(".tilwa-private", { recursive: true });
    await writeFile(
      ".tilwa-private/demo-workspace-code",
      workspace.workspaceCode,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        status: "passed",
        synthetic: true,
        tenantId: workspace.tenantId,
        workspaceCodeFile: ".tilwa-private/demo-workspace-code",
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "Seed failed",
      }),
    );
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
void main();
