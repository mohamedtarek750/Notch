import { requireAuth } from "@/server/auth";
import {
  approvePendingUmbrella,
  getMaterial,
  reviewPage,
  sourceErrorResponse,
} from "@/server/sources";
import { z } from "zod";
import { transcribePageImages, transcribeSparsePages } from "@/server/ocr";
const review = z.object({
  chunkId: z.string(),
  status: z.enum(["approved", "rejected", "quarantined"]),
  correctedText: z.string().min(20).max(30000).optional(),
});
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await getMaterial(await requireAuth(req, undefined, true), (await params).id),
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
    const ctx = await requireAuth(req, ["instructor"], true);
    const material = await getMaterial(ctx, (await params).id);
    const raw = await req.json();
    if (raw?.action === "transcribe")
      return Response.json(
        await transcribeSparsePages(ctx, material.material.id),
      );
    if (raw?.action === "transcribe-images")
      return Response.json(
        await transcribePageImages(ctx, material.material.id, raw.images),
      );
    if (raw?.action === "approve-pending")
      return Response.json(
        await approvePendingUmbrella(ctx, material.material.id),
      );
    const body = review.parse(raw);
    if (!material.chunks.some((c) => c.id === body.chunkId))
      return Response.json({ error: "invalid_chunk" }, { status: 400 });
    return Response.json(
      await reviewPage(ctx, body.chunkId, body.status, body.correctedText),
    );
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
