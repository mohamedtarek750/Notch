import { COURSE_COOKIE, requireAuth, setCookie } from "@/server/auth";
import { catalog, catalogAction } from "@/server/catalog";
import { errorResponse, localeFrom } from "@/server/errors";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return Response.json(await catalog(await requireAuth(request)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return errorResponse(e, localeFrom(request));
  }
}
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth(request);
    const result = await catalogAction(ctx, await request.json());
    const response = Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
    if ("courseId" in result && result.courseId)
      response.headers.append(
        "Set-Cookie",
        setCookie(COURSE_COOKIE, result.courseId, request, 60 * 60 * 24 * 90),
      );
    return response;
  } catch (e) {
    return errorResponse(e, localeFrom(request));
  }
}
