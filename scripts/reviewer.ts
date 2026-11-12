/** Privileged setup CLI: grant or revoke course review, never global promotion. */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
async function main() {
  try {
    if (
      !process.env.MIGRATION_DATABASE_URL &&
      process.env.LOCAL_DATABASE !== "1"
    )
      throw new Error(
        "MIGRATION_DATABASE_URL is required for privileged reviewer setup.",
      );
    if (process.env.MIGRATION_DATABASE_URL)
      process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
    const input = z
      .object({
        tenantId: z.string().uuid(),
        userId: z.string().uuid(),
        courseId: z.literal("CET351"),
        enabled: z.enum(["true", "false"]),
      })
      .parse({
        tenantId: process.argv[2],
        userId: process.argv[3],
        courseId: process.argv[4],
        enabled: process.argv[5],
      });
    await db.tenant(input.tenantId).transaction(async (tx) => {
      const changed = await tx.query(
        "UPDATE course_access SET can_review=$4,can_publish=$4 WHERE tenant_id=$1 AND user_id=$2 AND course_id=$3 AND access_role='instructor' AND active RETURNING user_id",
        [
          input.tenantId,
          input.userId,
          input.courseId,
          input.enabled === "true",
        ],
      );
      if (changed.rows.length !== 1)
        throw new Error("An active course instructor assignment is required.");
      await tx.query(
        "INSERT INTO audit_events(tenant_id,id,action,entity_id,data) VALUES($1,$2,$3,$4,$5)",
        [
          input.tenantId,
          randomUUID(),
          "admin.course-reviewer.changed",
          input.userId,
          JSON.stringify({
            courseId: input.courseId,
            enabled: input.enabled === "true",
            mechanism: "privileged-setup-cli",
            globalPromotion: false,
          }),
        ],
      );
    });
    console.log(
      JSON.stringify({
        status: "passed",
        courseId: input.courseId,
        reviewerEnabled: input.enabled === "true",
      }),
    );
  } catch {
    console.error(
      "Reviewer setup failed. Usage: tsx scripts/reviewer.ts <tenant UUID> <instructor UUID> CET351 <true|false>; use an authorized migration connection.",
    );
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
void main();
