import { requireAuth } from "@/server/auth";
import { workspace } from "@/server/learning";
import { errorResponse, localeFrom } from "@/server/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    return Response.json(await workspace(await requireAuth(request)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, localeFrom(request));
  }
}
