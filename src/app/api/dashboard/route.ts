import { requireAuth } from "@/server/auth";
import {
  advisorCaseload,
  dashboardAction,
  instructorDashboard,
  studentView,
} from "@/server/dashboard";
import { checkOrigin, errorResponse, localeFrom } from "@/server/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth(request, ["instructor", "advisor"]);
    const student = new URL(request.url).searchParams.get("student");
    return Response.json(
      student
        ? await studentView(ctx, student)
        : ctx.role === "advisor"
          ? await advisorCaseload(ctx)
          : await instructorDashboard(ctx),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, localeFrom(request));
  }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 25000)
      return Response.json(
        { error: { code: "INVALID_INPUT" } },
        { status: 413 },
      );
    return Response.json(
      await dashboardAction(
        await requireAuth(request, ["instructor", "advisor"]),
        await request.json(),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, localeFrom(request));
  }
}
