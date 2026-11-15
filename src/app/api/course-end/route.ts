import { requireAuth } from "@/server/auth";
import { courseEndAction, courseReport, myData } from "@/server/course-end";
import { checkOrigin, errorResponse, localeFrom } from "@/server/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth(request);
    const mine = new URL(request.url).searchParams.get("mine") === "1";
    return Response.json(mine ? await myData(ctx) : await courseReport(ctx), {
      headers: { "Cache-Control": "no-store" },
    });
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
      await courseEndAction(await requireAuth(request), await request.json()),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, localeFrom(request));
  }
}
