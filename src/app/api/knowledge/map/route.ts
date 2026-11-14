import { requireAuth } from "@/server/auth";
import {
  getPublishedConceptMap,
  knowledgeErrorResponse,
} from "@/server/coverage";
export const runtime = "nodejs";
export async function GET(req: Request) {
  try {
    return Response.json(await getPublishedConceptMap(await requireAuth(req)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      req.headers.get("accept-language") || "ar",
    );
  }
}
