import { requireAuth } from "@/server/auth";
import { knowledgeErrorResponse } from "@/server/coverage";
import { readKnowledgeGraph } from "@/server/knowledge-graph";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const ctx = await requireAuth(request);
    const result = await readKnowledgeGraph(ctx, new URL(request.url).searchParams);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return knowledgeErrorResponse(error, request.headers.get("accept-language") ?? "ar");
  }
}
