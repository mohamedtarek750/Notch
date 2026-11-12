import { requireAuth } from "@/server/auth";
import { learningAction } from "@/server/learning";
import { checkOrigin, errorResponse, localeFrom } from "@/server/errors";
export const dynamic = "force-dynamic";
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
      await learningAction(await requireAuth(request), await request.json()),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, localeFrom(request));
  }
}
