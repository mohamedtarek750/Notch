import { requireAuth } from "@/server/auth";
import { errorResponse, localeFrom } from "@/server/errors";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const user = await requireAuth(request);
    delete user.sessionId;
    return Response.json(
      {
        user,
        mode: process.env.DEMO_MODE === "true" ? "sandbox" : "institutional",
        synthetic: process.env.DEMO_MODE === "true",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e, localeFrom(request));
  }
}
