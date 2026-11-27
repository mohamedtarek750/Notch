import { after } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/server/db";
import { drainCourse } from "@/server/build-jobs";
export const maxDuration = 300;
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const header = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from("Bearer " + secret);
  if (
    !secret ||
    header.length !== expected.length ||
    !timingSafeEqual(header, expected)
  )
    return new Response(null, { status: 401 });
  after(async () => {
    const deadline = Date.now() + 90000;
    const tenants = await db.query<{ id: string }>(
      "SELECT id FROM tenants ORDER BY id",
    );
    for (const tenant of tenants.rows) {
      const courses = await db
        .tenant(tenant.id)
        .query<{ course_id: string }>(
          "SELECT DISTINCT course_id FROM km_build_jobs WHERE tenant_id=$1 AND status IN ('queued','processing') AND (lease_until IS NULL OR lease_until<now())",
          [tenant.id],
        );
      for (const c of courses.rows) {
        if (Date.now() > deadline) return;
        await drainCourse(tenant.id, c.course_id);
      }
    }
  });
  return Response.json({ scheduled: true });
}
