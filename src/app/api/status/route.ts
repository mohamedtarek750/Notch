import { db } from "@/server/db";
export const dynamic = "force-dynamic";
/** SYS2: is each part of the system up? No secrets, no user data. */
export async function GET() {
  let database = false;
  try {
    await db.query("SELECT 1");
    database = true;
  } catch {
    database = false;
  }
  const tutor = !!process.env.GEMINI_API_KEY && !!process.env.GEMINI_MODEL;
  return Response.json(
    {
      checkedAt: new Date().toISOString(),
      subsystems: {
        login: database,
        practice: database,
        dashboards: database,
        // Configured, not necessarily reachable: the provider is only called for real questions.
        tutor: database && tutor,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
