import { requireAuth } from "@/server/auth";
import {
  advisorCaseload,
  conceptDetail,
  examClassReadiness,
  reviewPack,
  dashboardAction,
  instructorDashboard,
  studentView,
} from "@/server/dashboard";
import { checkOrigin, errorResponse, localeFrom } from "@/server/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth(request, ["instructor", "advisor"]);
    const params = new URL(request.url).searchParams;
    const student = params.get("student");
    if (params.get("concept"))
      return Response.json(await conceptDetail(ctx, params.get("concept")!), {
        headers: { "Cache-Control": "no-store" },
      });
    if (params.get("exams"))
      return Response.json(await examClassReadiness(ctx), {
        headers: { "Cache-Control": "no-store" },
      });
    if (params.get("pack"))
      return Response.json(
        await reviewPack(ctx, params.get("pack")!.split(",").filter(Boolean)),
        { headers: { "Cache-Control": "no-store" } },
      );
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
