import { requireAuth } from "@/server/auth";
import { tutor, tutorInput } from "@/server/ai";
import { sourceErrorResponse } from "@/server/sources";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(req: Request) {
  try {
    const ctx = await requireAuth(req);
    const input = tutorInput.parse(await req.json());
    return Response.json(await tutor(ctx, input), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
