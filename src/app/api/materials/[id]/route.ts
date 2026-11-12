import { requireAuth } from "@/server/auth";
import { getMaterial, reviewPage, sourceErrorResponse } from "@/server/sources";
import { z } from "zod";
const review = z.object({
  chunkId: z.string(),
  status: z.enum(["approved", "rejected", "quarantined"]),
  correctedText: z.string().min(20).max(30000).optional(),
});
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await getMaterial(await requireAuth(req), (await params).id),
    );
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth(req, ["instructor"]);
    const material = await getMaterial(ctx, (await params).id);
    const body = review.parse(await req.json());
    if (!material.chunks.some((c) => c.id === body.chunkId))
      return Response.json({ error: "invalid_chunk" }, { status: 400 });
    return Response.json(
      await reviewPage(ctx, body.chunkId, body.status, body.correctedText),
    );
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
